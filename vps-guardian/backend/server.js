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

const { exec } = require('child_process');
const axios = require('axios');

app.use(cors());
app.use(compression());
app.use(express.json());

// ==================== Configurações Dinâmicas ====================
const CONFIG_PATH = path.join(__dirname, 'config.json');
let globalSettings = {
  backupDir: process.env.BACKUP_DIR || '/var/backups/vps-guardian',
  maxBackups: parseInt(process.env.MAX_BACKUPS) || 6,
  webhookEnabled: process.env.WEBHOOK_ENABLED === 'true',
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookType: process.env.WEBHOOK_TYPE || 'slack',
  cpuThreshold: parseInt(process.env.CPU_THRESHOLD) || 90,
  memoryThreshold: parseInt(process.env.MEMORY_THRESHOLD) || 90,
  diskThreshold: parseInt(process.env.DISK_THRESHOLD) || 85,
  monitoringInterval: parseInt(process.env.MONITORING_INTERVAL) || 30
};

function loadSettings() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(fileContent);
      globalSettings = { ...globalSettings, ...parsed };
      logger.info('✅ Configurações carregadas do config.json');
    } catch (e) {
      logger.error('Erro ao ler config.json: ' + e.message);
    }
  }
}

function saveSettings(settings) {
  globalSettings = { ...globalSettings, ...settings };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalSettings, null, 2), 'utf8');
    logger.info('✅ Configurações salvas em config.json');
    return true;
  } catch (e) {
    logger.error('Erro ao salvar config.json: ' + e.message);
    return false;
  }
}

loadSettings();

// ==================== Registro de Alertas & Webhooks ====================
const activeAlerts = new Map();
let criticalAlertsCount = 0;

async function sendWebhook(level, title, message) {
  if (!globalSettings.webhookEnabled || !globalSettings.webhookUrl) return;
  try {
    let payload = {};
    if (globalSettings.webhookType === 'slack') {
      payload = {
        text: `*${level.toUpperCase()}: ${title}*\n${message}\n_Host: VPS Guardian_`
      };
    } else if (globalSettings.webhookType === 'discord') {
      const color = level === 'critical' ? 16711680 : level === 'warning' ? 16753920 : 65280;
      payload = {
        embeds: [{
          title: `${level.toUpperCase()}: ${title}`,
          description: message,
          color: color,
          footer: { text: 'VPS Guardian' },
          timestamp: new Date().toISOString()
        }]
      };
    } else {
      payload = { level, title, message, host: 'vps-guardian', timestamp: new Date().toISOString() };
    }
    await axios.post(globalSettings.webhookUrl, payload);
    logger.info(`🔔 Webhook enviado com sucesso (${globalSettings.webhookType})`);
  } catch (e) {
    logger.error(`❌ Falha ao enviar webhook: ${e.message}`);
  }
}

function checkThresholds(metrics) {
  // CPU check
  if (metrics.cpu.usage > globalSettings.cpuThreshold) {
    if (!activeAlerts.has('cpu')) {
      const title = 'Alto Uso de CPU';
      const msg = `O uso de CPU no VPS atingiu ${metrics.cpu.usage}% (Limite configurado: ${globalSettings.cpuThreshold}%).`;
      activeAlerts.set('cpu', { level: 'critical', title, message: msg, time: Date.now() });
      criticalAlertsCount++;
      sendWebhook('critical', title, msg);
    }
  } else {
    if (activeAlerts.has('cpu')) {
      activeAlerts.delete('cpu');
      if (criticalAlertsCount > 0) criticalAlertsCount--;
      sendWebhook('info', 'CPU Normalizada', `O uso de CPU reduziu para ${metrics.cpu.usage}%.`);
    }
  }

  // RAM check
  if (metrics.memory.percent > globalSettings.memoryThreshold) {
    if (!activeAlerts.has('memory')) {
      const title = 'Alto Uso de RAM';
      const msg = `O uso de RAM no VPS atingiu ${metrics.memory.percent}% (Limite configurado: ${globalSettings.memoryThreshold}%).`;
      activeAlerts.set('memory', { level: 'critical', title, message: msg, time: Date.now() });
      criticalAlertsCount++;
      sendWebhook('critical', title, msg);
    }
  } else {
    if (activeAlerts.has('memory')) {
      activeAlerts.delete('memory');
      if (criticalAlertsCount > 0) criticalAlertsCount--;
      sendWebhook('info', 'RAM Normalizada', `O uso de RAM reduziu para ${metrics.memory.percent}%.`);
    }
  }

  // Disk check
  if (metrics.disk.percent > globalSettings.diskThreshold) {
    if (!activeAlerts.has('disk')) {
      const title = 'Pouco Espaço em Disco';
      const msg = `O uso de disco no VPS atingiu ${metrics.disk.percent}% (Limite configurado: ${globalSettings.diskThreshold}%).`;
      activeAlerts.set('disk', { level: 'critical', title, message: msg, time: Date.now() });
      criticalAlertsCount++;
      sendWebhook('critical', title, msg);
    }
  } else {
    if (activeAlerts.has('disk')) {
      activeAlerts.delete('disk');
      if (criticalAlertsCount > 0) criticalAlertsCount--;
      sendWebhook('info', 'Espaço em Disco Normalizado', `O uso de disco estabilizou em ${metrics.disk.percent}%.`);
    }
  }
}

// ==================== Auto-Restart de Containers ====================
const lastContainerStates = new Map();

async function checkContainersAutoRestart() {
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      const id = c.Id.substring(0, 12);
      const name = c.Names[0]?.replace('/', '') || 'unknown';
      const currentState = c.State;
      const prevState = lastContainerStates.get(id);

      if (prevState === 'running' && currentState === 'exited') {
        logger.warn(`⚠️ Container caído detectado: ${name} (${id}). Tentando auto-restart...`);
        sendWebhook('warning', 'Container Caído', `O container ${name} caiu. Tentando reinício automático...`);
        
        try {
          const container = docker.getContainer(c.Id);
          await container.start();
          logger.info(`✅ Container ${name} reiniciado com sucesso via auto-restart.`);
          sendWebhook('info', 'Container Recuperado', `O container ${name} foi reiniciado com sucesso.`);
        } catch (err) {
          logger.error(`❌ Falha ao reiniciar container ${name}: ${err.message}`);
          sendWebhook('critical', 'Falha no Auto-Restart', `Não foi possível reiniciar o container ${name}. Erro: ${err.message}`);
        }
      }
      lastContainerStates.set(id, currentState);
    }
  } catch (e) {
    logger.error('Erro na verificação de auto-restart: ' + e.message);
  }
}

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

// ==================== Settings ====================
app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: globalSettings });
});

app.post('/api/settings', (req, res) => {
  const success = saveSettings(req.body);
  if (success) {
    res.json({ success: true, message: 'Configurações salvas com sucesso', data: globalSettings });
  } else {
    res.status(500).json({ success: false, error: 'Falha ao salvar configurações' });
  }
});

// ==================== Backups ====================
function runBackup() {
  return new Promise((resolve, reject) => {
    const backupDir = globalSettings.backupDir;
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.tar.gz`;
    const filepath = path.join(backupDir, filename);

    // Compacta logs da aplicação para um arquivo tar real no volume
    exec(`tar -czf "${filepath}" -C /app logs`, (err, stdout, stderr) => {
      if (err) {
        logger.error(`❌ Erro no backup: ${err.message}`);
        reject(err);
      } else {
        logger.info(`✅ Backup concluído: ${filename}`);
        
        // Retenção
        try {
          const files = fs.readdirSync(backupDir)
            .filter(f => f.endsWith('.tar.gz'))
            .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
          
          if (files.length > globalSettings.maxBackups) {
            for (let i = globalSettings.maxBackups; i < files.length; i++) {
              fs.unlinkSync(path.join(backupDir, files[i].name));
              logger.info(`🧹 Backup antigo removido por retenção: ${files[i].name}`);
            }
          }
        } catch (e) {
          logger.error(`Erro na retenção de backups: ${e.message}`);
        }
        resolve({ filename, id: `backup-${timestamp}` });
      }
    });
  });
}

app.get('/api/backups', (req, res) => {
  try {
    const backupDir = globalSettings.backupDir;
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
    const result = await runBackup();
    res.json({ success: true, message: 'Backup concluído com sucesso', id: result.id, name: result.filename });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/backups/:id', (req, res) => {
  try {
    const backupDir = globalSettings.backupDir;
    const filename = `${req.params.id}.tar.gz`;
    const filepath = path.join(backupDir, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      logger.info(`🗑️ Backup removido manualmente: ${filename}`);
      res.json({ success: true, message: 'Backup deletado com sucesso' });
    } else {
      res.status(404).json({ success: false, error: 'Backup não encontrado' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/backups/:id/restore', async (req, res) => {
  try {
    const backupDir = globalSettings.backupDir;
    const filename = `${req.params.id}.tar.gz`;
    const filepath = path.join(backupDir, filename);
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: 'Backup não encontrado' });
    }

    logger.info(`🔄 Restauração iniciada para: ${filename}`);
    exec(`tar -xzf "${filepath}" -C /`, (err, stdout, stderr) => {
      if (err) {
        logger.error(`❌ Erro na restauração: ${err.message}`);
      } else {
        logger.info(`✅ Restauração concluída com sucesso: ${filename}`);
      }
    });

    res.json({ success: true, message: 'Restauração iniciada com sucesso' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Dashboard (agregado) ====================
app.get('/api/dashboard', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const running = containers.filter(c => c.State === 'running').length;

    const backupDir = globalSettings.backupDir;
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
        alerts: { active: activeAlerts.size, critical: criticalAlertsCount },
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
// Coleta de métricas para alimentar o histórico e checar limites/auto-restart
cron.schedule('*/30 * * * * *', async () => {
  let sample = null;
  try {
    sample = await collectSystemMetrics();
    pushSample(sample);
    // Checagem de limites e webhooks
    checkThresholds(sample);
  } catch (error) {
    logger.error('Erro coleta: ' + error.message);
  }

  // Verificação de auto-restart
  await checkContainersAutoRestart();

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
cron.schedule('0 1 * * *', async () => {
  logger.info('⏰ Backup automático iniciado');
  try {
    await runBackup();
    sendWebhook('info', 'Backup Diário Realizado', 'O backup automático diário de logs foi concluído com sucesso.');
  } catch (e) {
    logger.error('Erro no backup automático: ' + e.message);
    sendWebhook('critical', 'Falha no Backup Diário', `Falha ao realizar o backup automático diário. Erro: ${e.message}`);
  }
});

// Limpeza semanal domingo 04:00
cron.schedule('0 4 * * 0', async () => {
  logger.info('🧹 Limpeza automática iniciada');
  try {
    const pruneImages = await docker.pruneImages({ all: true });
    const pruneContainers = await docker.pruneContainers();
    const imgsCount = pruneImages.ImagesDeleted?.length || 0;
    const contsCount = pruneContainers.ContainersDeleted?.length || 0;
    logger.info(`🧹 Limpeza Concluída. Imagens removidas: ${imgsCount}, Containers removidos: ${contsCount}`);
    sendWebhook('info', 'Limpeza Semanal Realizada', `A limpeza semanal foi concluída no VPS.\n- Imagens limpas: ${imgsCount}\n- Containers limpos: ${contsCount}`);
  } catch (e) {
    logger.error('Erro na limpeza automática: ' + e.message);
    sendWebhook('warning', 'Falha na Limpeza Semanal', `Erro ao realizar a limpeza de containers e imagens órfãs: ${e.message}`);
  }
});

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
