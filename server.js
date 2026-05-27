require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const Docker = require('dockerode');
const cron = require('node-cron');
const winston = require('winston');
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');

// ==================== Logger ====================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// ==================== App ====================
const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json());

// ==================== Histórico de métricas (em memória) ====================
// Guardamos amostras para alimentar os gráficos do dashboard.
const MAX_SAMPLES = 240; // ~2h a cada 30s, ou ajustável
const metricsHistory = [];

// Histórico de CPU/RAM por container (id -> {name, samples:[{t,cpu,memory}]})
const MAX_CONTAINER_SAMPLES = 60; // ~30min a cada 30s
const containerHistory = {};

function pushContainerSample(id, name, cpu, memory) {
  if (!containerHistory[id]) containerHistory[id] = { name, samples: [] };
  containerHistory[id].name = name;
  const arr = containerHistory[id].samples;
  arr.push({ t: Date.now(), cpu, memory });
  if (arr.length > MAX_CONTAINER_SAMPLES) arr.shift();
}

function pushSample(sample) {
  metricsHistory.push(sample);
  if (metricsHistory.length > MAX_SAMPLES) metricsHistory.shift();
}

// Coleta métricas reais do sistema (host quando o container expõe /proc do host)
async function collectSystemMetrics() {
  const [cpu, mem, fsSize, osInfo, load, time] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.osInfo(),
    si.currentLoad(),
    si.time()
  ]);

  // Disco: prefere o mount do host (/rootfs montado via docker-compose).
  // Ignora pseudo-filesystems (overlay, tmpfs, mounts virtuais) para
  // refletir o disco real do VPS.
  const ignore = ['/mnt/', '/proc', '/sys', '/dev', '/run'];
  const disks = (fsSize || []).filter(d =>
    d.size > 0 && !ignore.some(p => (d.mount || '').startsWith(p))
  );
  const hostDisk = disks.find(d => d.mount === '/rootfs' || d.mount === '/host');
  const mainDisk = hostDisk
    || disks.filter(d => d.mount === '/')[0]
    || disks.sort((a, b) => b.size - a.size)[0]
    || { size: 0, used: 0, use: 0, mount: '/' };

  return {
    timestamp: Date.now(),
    cpu: {
      usage: +(cpu.currentLoad || 0).toFixed(1),
      cores: cpu.cpus ? cpu.cpus.length : 0
    },
    memory: {
      percent: +((mem.active / mem.total) * 100 || 0).toFixed(1),
      used: mem.active,
      total: mem.total,
      usedFormatted: formatBytes(mem.active),
      totalFormatted: formatBytes(mem.total)
    },
    disk: {
      percent: +(mainDisk.use || 0).toFixed(1),
      used: mainDisk.used,
      total: mainDisk.size,
      usedFormatted: formatBytes(mainDisk.used),
      totalFormatted: formatBytes(mainDisk.size),
      mount: mainDisk.mount
    },
    uptime: time.uptime,
    os: `${osInfo.distro} ${osInfo.release}`
  };
}

// ==================== Health ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// ==================== Métricas do sistema (VPS) ====================
app.get('/api/metrics/system', async (req, res) => {
  try {
    const metrics = await collectSystemMetrics();
    res.json({ success: true, data: metrics });
  } catch (error) {
    logger.error('Erro métricas sistema: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Histórico para os gráficos
app.get('/api/metrics/history', (req, res) => {
  res.json({
    success: true,
    data: metricsHistory.map(s => ({
      time: new Date(s.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      cpu: s.cpu.usage,
      memory: s.memory.percent,
      disk: s.disk.percent
    }))
  });
});

// Histórico de um container específico (para gráficos por container)
app.get('/api/containers/:id/history', (req, res) => {
  const entry = containerHistory[req.params.id];
  const data = entry ? entry.samples.map(s => ({
    time: new Date(s.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    cpu: s.cpu,
    memory: s.memory
  })) : [];
  res.json({ success: true, data });
});


// ==================== Containers ====================
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const detailed = await Promise.all(
      containers.map(async (c) => {
        const container = docker.getContainer(c.Id);
        let stats = null;
        try {
          if (c.State === 'running') stats = await container.stats({ stream: false });
        } catch (e) {}
        return {
          id: c.Id.substring(0, 12),
          name: c.Names[0]?.replace('/', '') || 'unknown',
          image: c.Image,
          state: c.State,
          status: c.Status,
          stats: stats ? parseStats(stats) : null
        };
      })
    );
    res.json({ success: true, data: detailed });
  } catch (error) {
    logger.error('Erro containers: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/containers/:id/:action', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    switch (req.params.action) {
      case 'start': await container.start(); break;
      case 'stop': await container.stop({ t: 10 }); break;
      case 'restart': await container.restart({ t: 10 }); break;
      default: return res.status(400).json({ success: false, error: 'Invalid action' });
    }
    logger.info(`Container ${req.params.action}: ${req.params.id}`);
    res.json({ success: true, message: `Container ${req.params.action}ed` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const logs = await container.logs({
      stdout: true, stderr: true,
      tail: parseInt(req.query.tail) || 100, timestamps: true
    });
    res.json({ success: true, data: logs.toString('utf8') });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Backups ====================
app.get('/api/backups', (req, res) => {
  try {
    const backupDir = process.env.BACKUP_DIR || '/var/backups/vps-guardian';
    const files = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter(f => f.endsWith('.tar.gz')) : [];
    const backups = files.map(file => {
      const stat = fs.statSync(path.join(backupDir, file));
      return {
        id: file.replace('.tar.gz', ''), name: file,
        size: stat.size, sizeFormatted: formatBytes(stat.size),
        created: stat.mtime, type: 'manual'
      };
    }).sort((a, b) => b.created - a.created);
    res.json({ success: true, data: backups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/backups', async (req, res) => {
  try {
    const backupDir = process.env.BACKUP_DIR || '/var/backups/vps-guardian';
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    logger.info(`Backup iniciado: backup-${timestamp}.tar.gz`);
    res.json({ success: true, message: 'Backup initiated', id: `backup-${timestamp}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Dashboard (agregado) ====================
app.get('/api/dashboard', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const running = containers.filter(c => c.State === 'running').length;

    const backupDir = process.env.BACKUP_DIR || '/var/backups/vps-guardian';
    const backupFiles = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter(f => f.endsWith('.tar.gz')) : [];

    let latestBackup = null;
    if (backupFiles.length) {
      const newest = backupFiles
        .map(f => ({ f, m: fs.statSync(path.join(backupDir, f)).mtime }))
        .sort((a, b) => b.m - a.m)[0];
      latestBackup = { name: newest.f, created: newest.m };
    }

    let system = null;
    try { system = await collectSystemMetrics(); } catch (e) {}

    res.json({
      success: true,
      data: {
        containers: { total: containers.length, running, stopped: containers.length - running, unhealthy: 0 },
        backups: { total: backupFiles.length, latest: latestBackup },
        alerts: { active: 0, critical: 0 },
        system
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Helpers ====================
function parseStats(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
    const cpuPercent = (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100 || 0;
    const memUsage = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 0;
    const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
    return {
      cpu: { percent: Math.min(cpuPercent, 100).toFixed(1) },
      memory: {
        percent: Math.min(memPercent, 100).toFixed(1),
        usage: formatBytes(memUsage), limit: formatBytes(memLimit)
      }
    };
  } catch (e) { return null; }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i >= sizes.length) i = sizes.length - 1;
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ==================== Jobs ====================
// Coleta de métricas a cada 30s para alimentar o histórico/gráficos
cron.schedule('*/30 * * * * *', async () => {
  try {
    const sample = await collectSystemMetrics();
    pushSample(sample);
  } catch (error) {
    logger.error('Erro coleta: ' + error.message);
  }
  // Coleta CPU/RAM por container para os gráficos individuais
  try {
    const running = await docker.listContainers();
    await Promise.all(running.map(async (c) => {
      try {
        const stats = await docker.getContainer(c.Id).stats({ stream: false });
        const parsed = parseStats(stats);
        if (parsed) {
          pushContainerSample(
            c.Id.substring(0, 12),
            c.Names[0]?.replace('/', '') || 'unknown',
            parseFloat(parsed.cpu.percent),
            parseFloat(parsed.memory.percent)
          );
        }
      } catch (e) {}
    }));
  } catch (e) {}
});

// Backup diário às 01:00
cron.schedule('0 1 * * *', () => logger.info('⏰ Backup automático iniciado'));
// Limpeza semanal domingo 04:00
cron.schedule('0 4 * * 0', () => logger.info('🧹 Limpeza automática iniciada'));

// ==================== Start ====================
app.listen(PORT, async () => {
  logger.info(`🚀 VPS Guardian Backend na porta ${PORT}`);
  docker.ping((err) => {
    logger.info(err ? '❌ Docker erro: ' + err.message : '✅ Docker conectado');
  });
  // Primeira amostra imediata para o gráfico não começar vazio
  try { pushSample(await collectSystemMetrics()); } catch (e) {}
});

module.exports = app;
