import { useState, useEffect } from 'react'
import { Database, Plus, RefreshCw, Trash2, RotateCcw, AlertTriangle, Calendar, FileArchive } from 'lucide-react'
import toast from 'react-hot-toast'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || '/api'

export default function Backups() {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const loadBackups = async (showToast = false) => {
    if (showToast) setRefreshing(true)
    try {
      const res = await axios.get(`${API}/backups`)
      if (res.data?.success) {
        setBackups(res.data.data || [])
        if (showToast) toast.success('Lista de backups atualizada')
      }
    } catch (e) {
      toast.error('Falha ao carregar backups')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadBackups()
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    const tId = toast.loading('Compactando logs e criando backup...')
    try {
      const res = await axios.post(`${API}/backups`)
      if (res.data?.success) {
        toast.success('Backup gerado com sucesso!', { id: tId })
        loadBackups()
      } else {
        toast.error('Erro ao gerar o backup', { id: tId })
      }
    } catch (err) {
      toast.error('Erro de rede ao criar backup', { id: tId })
    } finally {
      setCreating(false)
    }
  }

  const handleRestore = async (id) => {
    if (!confirm('Deseja realmente restaurar este backup? Os logs e estados da aplicação serão restaurados para a data do arquivo.')) return

    const tId = toast.loading('Restaurando dados do backup...')
    try {
      const res = await axios.post(`${API}/backups/${id}/restore`)
      if (res.data?.success) {
        toast.success('Restauração concluída com sucesso!', { id: tId })
      } else {
        toast.error('Falha na restauração do backup', { id: tId })
      }
    } catch (e) {
      toast.error('Erro de rede ao restaurar backup', { id: tId })
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Deseja realmente excluir permanentemente este backup? Esta ação não pode ser desfeita.')) return

    const tId = toast.loading('Removendo backup...')
    try {
      const res = await axios.delete(`${API}/backups/${id}`)
      if (res.data?.success) {
        toast.success('Backup removido com sucesso!', { id: tId })
        setBackups(prev => prev.filter(b => b.id !== id))
      } else {
        toast.error('Falha ao remover o backup', { id: tId })
      }
    } catch (e) {
      toast.error('Erro de rede ao excluir backup', { id: tId })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-dark-400">Carregando gerenciador de backups...</p>
        </div>
      </div>
    )
  }

  const stats = {
    total: backups.length,
    latest: backups.length > 0 ? backups[0] : null
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-2">
            <Database className="w-8 h-8 text-green-500" /> Backups
          </h1>
          <p className="text-dark-400">Crie, delete e gerencie pontos de restauração compactados da aplicação</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => loadBackups(true)}
            className="btn-secondary flex items-center gap-2"
            disabled={refreshing}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
          <button
            onClick={handleCreate}
            className="btn-primary flex items-center gap-2"
            disabled={creating}
          >
            {creating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Criar Backup
          </button>
        </div>
      </div>

      {/* Cards de Métricas */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-6">
          <div className="text-sm font-semibold text-dark-400 mb-1">Total de Backups</div>
          <div className="text-3xl font-bold text-white tabular-nums">{stats.total}</div>
          <p className="text-xs text-dark-500 mt-2">Armazenados no volume local da VPS</p>
        </div>
        <div className="card p-6">
          <div className="text-sm font-semibold text-dark-400 mb-1">Último Backup</div>
          <div className="text-lg font-bold text-white truncate">
            {stats.latest ? stats.latest.name : '—'}
          </div>
          <p className="text-xs text-dark-500 mt-2">
            {stats.latest ? new Date(stats.latest.created).toLocaleString('pt-BR') : 'Sem backups criados'}
          </p>
        </div>
        <div className="card p-6">
          <div className="text-sm font-semibold text-dark-400 mb-1">Rotina Automática</div>
          <div className="text-3xl font-bold text-green-500">Ativa</div>
          <p className="text-xs text-dark-500 mt-2">Agendado diariamente às 01:00 da manhã</p>
        </div>
      </div>

      {/* Tabela de Backups */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <FileArchive className="w-5 h-5 text-blue-500" /> Histórico de Pontos de Restauração
        </h2>
        {backups.length === 0 ? (
          <div className="py-12 text-center text-dark-500">
            <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Nenhum backup disponível na VPS</p>
            <p className="text-xs mt-1">Clique em "Criar Backup" no topo para gerar o primeiro ponto.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-dark-300">
              <thead className="text-xs uppercase text-dark-500 border-b border-dark-800">
                <tr>
                  <th className="py-3 px-4">Nome do Arquivo</th>
                  <th className="py-3 px-4">Tamanho</th>
                  <th className="py-3 px-4">Criado Em</th>
                  <th className="py-3 px-4 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-900">
                {backups.map(b => (
                  <tr key={b.id} className="hover:bg-dark-900/40 transition-colors">
                    <td className="py-4 px-4 font-medium text-white flex items-center gap-2.5 truncate max-w-xs">
                      <FileArchive className="w-4 h-4 text-amber-500 shrink-0" />
                      {b.name}
                    </td>
                    <td className="py-4 px-4 tabular-nums">{b.sizeFormatted}</td>
                    <td className="py-4 px-4 text-xs">
                      <div className="flex items-center gap-1.5 text-dark-400">
                        <Calendar className="w-3.5 h-3.5" />
                        {new Date(b.created).toLocaleString('pt-BR')}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleRestore(b.id)}
                          title="Restaurar este ponto"
                          className="btn-secondary py-1.5 px-3 flex items-center gap-1 text-xs hover:bg-green-600/10 hover:text-green-500 hover:border-green-600/30"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Restaurar
                        </button>
                        <button
                          onClick={() => handleDelete(b.id)}
                          title="Excluir backup"
                          className="btn-secondary py-1.5 px-3 flex items-center gap-1 text-xs text-red-400 hover:bg-red-600/10 hover:text-red-500 hover:border-red-600/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Excluir
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
