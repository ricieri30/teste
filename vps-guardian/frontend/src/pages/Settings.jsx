import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Save, AlertTriangle, ShieldAlert, Database, BellRing, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || '/api'

export default function Settings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState({
    cpuThreshold: 90,
    memoryThreshold: 90,
    diskThreshold: 85,
    webhookEnabled: false,
    webhookUrl: '',
    webhookType: 'slack',
    maxBackups: 6,
    monitoringInterval: 30
  })

  useEffect(() => {
    async function load() {
      try {
        const res = await axios.get(`${API}/settings`)
        if (res.data?.success) {
          setSettings(res.data.data)
        }
      } catch (e) {
        toast.error('Erro ao carregar configurações do servidor')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target
    setSettings(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? parseInt(value) || 0 : value
    }))
  }

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    const tId = toast.loading('Salvando configurações...')
    try {
      const res = await axios.post(`${API}/settings`, settings)
      if (res.data?.success) {
        setSettings(res.data.data)
        toast.success('Configurações salvas com sucesso!', { id: tId })
      } else {
        toast.error('Erro ao salvar as configurações', { id: tId })
      }
    } catch (err) {
      toast.error('Falha na comunicação com o servidor', { id: tId })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-dark-400">Carregando painel de controle...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-2">
          <SettingsIcon className="w-8 h-8 text-blue-500" /> Configurações
        </h1>
        <p className="text-dark-400">Gerencie limites de recursos, alertas por webhooks e backups do VPS</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Limites de Recursos */}
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 border-b border-dark-800 pb-3">
            <ShieldAlert className="w-5 h-5 text-amber-500" /> Limites de Alerta (Thresholds)
          </h2>
          <p className="text-xs text-dark-500">
            Configure as porcentagens limite. Caso o consumo do VPS supere esses valores, um alerta será disparado e enviado para o canal configurado.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-dark-300 mb-1.5">CPU Máxima (%)</label>
              <input
                type="number"
                name="cpuThreshold"
                min="10"
                max="100"
                value={settings.cpuThreshold}
                onChange={handleChange}
                className="input text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-dark-300 mb-1.5">Memória RAM Máxima (%)</label>
              <input
                type="number"
                name="memoryThreshold"
                min="10"
                max="100"
                value={settings.memoryThreshold}
                onChange={handleChange}
                className="input text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-dark-300 mb-1.5">Disco Máximo (%)</label>
              <input
                type="number"
                name="diskThreshold"
                min="10"
                max="100"
                value={settings.diskThreshold}
                onChange={handleChange}
                className="input text-sm"
                required
              />
            </div>
          </div>
        </div>

        {/* Backups e Monitoramento */}
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 border-b border-dark-800 pb-3">
            <Database className="w-5 h-5 text-blue-500" /> Backups e Monitoramento
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-dark-300 mb-1.5">Retenção Máxima de Backups</label>
              <input
                type="number"
                name="maxBackups"
                min="1"
                max="50"
                value={settings.maxBackups}
                onChange={handleChange}
                className="input text-sm"
                required
              />
              <p className="text-[10px] text-dark-500 mt-1">Número de arquivos `.tar.gz` retidos antes da remoção automática.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-dark-300 mb-1.5">Intervalo de Monitoramento (segundos)</label>
              <input
                type="number"
                name="monitoringInterval"
                min="5"
                max="300"
                value={settings.monitoringInterval}
                onChange={handleChange}
                className="input text-sm"
                required
              />
              <p className="text-[10px] text-dark-500 mt-1">Frequência de atualização das amostras de gráficos e checagem de regras.</p>
            </div>
          </div>
        </div>

        {/* Notificações e Webhooks */}
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 border-b border-dark-800 pb-3">
            <BellRing className="w-5 h-5 text-green-500" /> Canais de Notificação (Webhooks)
          </h2>
          <div className="flex items-center space-x-3 bg-dark-900 border border-dark-800 p-3 rounded-lg">
            <input
              type="checkbox"
              id="webhookEnabled"
              name="webhookEnabled"
              checked={settings.webhookEnabled}
              onChange={handleChange}
              className="w-4.5 h-4.5 rounded text-blue-600 focus:ring-blue-500 bg-dark-800 border-dark-700"
            />
            <label htmlFor="webhookEnabled" className="text-sm font-medium text-white cursor-pointer select-none">
              Habilitar Notificações via Webhook
            </label>
          </div>

          {settings.webhookEnabled && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="md:col-span-1">
                  <label className="block text-xs font-medium text-dark-300 mb-1.5">Tipo de Webhook</label>
                  <select
                    name="webhookType"
                    value={settings.webhookType}
                    onChange={handleChange}
                    className="input text-sm h-[42px] bg-dark-950 border-dark-700"
                  >
                    <option value="slack">Slack</option>
                    <option value="discord">Discord</option>
                    <option value="general">Webhook JSON</option>
                  </select>
                </div>
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium text-dark-300 mb-1.5">URL do Webhook</label>
                  <input
                    type="url"
                    name="webhookUrl"
                    placeholder="https://hooks.slack.com/services/... ou https://discord.com/api/webhooks/..."
                    value={settings.webhookUrl}
                    onChange={handleChange}
                    className="input text-sm"
                    required={settings.webhookEnabled}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Botão de Salvar */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="btn-primary flex items-center gap-2 px-6 py-2.5"
          >
            {saving ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Salvar Configurações
          </button>
        </div>
      </form>
    </div>
  )
}
