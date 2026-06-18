import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Pencil, Trash2, X } from 'lucide-react'
import type { Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'

// Drawer that surfaces every model row for one platform — regardless of source
// (migration / catalog / user) — and routes the maintainer's actions through
// the right /api/models endpoint:
//   - source='user'   → [Edit] + [Delete]   (DELETE hard-deletes the row)
//   - source!='user'  → [Edit] only         (Switch flips enabled via PATCH)
// The "Add" form drops a brand new row in as source='user' (POST).

interface ModelRow {
  id: number
  platform: Platform
  modelId: string
  displayName: string
  contextWindow: number | null
  enabled: boolean
  supportsVision: boolean
  supportsTools: boolean
  source: 'migration' | 'catalog' | 'user'
}

interface Props {
  open: boolean
  onClose: () => void
  platform: Platform
  platformLabel: string
}

export function ManageModelsDrawer({ open, onClose, platform, platformLabel }: Props) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: allModels = [] } = useQuery<ModelRow[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
    enabled: open,
  })
  const rows = allModels.filter(m => m.platform === platform)

  const [showAdd, setShowAdd] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newContextWindow, setNewContextWindow] = useState('')
  const [newSupportsVision, setNewSupportsVision] = useState(false)
  const [newSupportsTools, setNewSupportsTools] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<{ displayName: string; contextWindow: string; supportsVision: boolean; supportsTools: boolean }>({
    displayName: '',
    contextWindow: '',
    supportsVision: false,
    supportsTools: false,
  })
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['models'] })

  const addModel = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch('/api/models', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidate()
      setShowAdd(false)
      setNewModelId('')
      setNewDisplayName('')
      setNewContextWindow('')
      setNewSupportsVision(false)
      setNewSupportsTools(false)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to add model'),
  })

  const updateModel = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      apiFetch(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to update model'),
  })

  const deleteModel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate()
      setConfirmDeleteId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to delete model'),
  })

  function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newModelId.trim()) return
    const payload: Record<string, unknown> = {
      platform,
      modelId: newModelId.trim(),
    }
    if (newDisplayName.trim()) payload.displayName = newDisplayName.trim()
    const ctx = Number(newContextWindow)
    if (newContextWindow && Number.isFinite(ctx)) payload.contextWindow = ctx
    if (newSupportsVision) payload.supportsVision = true
    if (newSupportsTools) payload.supportsTools = true
    addModel.mutate(payload)
  }

  function startEdit(row: ModelRow) {
    setEditingId(row.id)
    setEditDraft({
      displayName: row.displayName,
      contextWindow: row.contextWindow == null ? '' : String(row.contextWindow),
      supportsVision: row.supportsVision,
      supportsTools: row.supportsTools,
    })
  }

  function submitEdit(id: number) {
    const patch: Record<string, unknown> = {
      displayName: editDraft.displayName,
      supportsVision: editDraft.supportsVision,
      supportsTools: editDraft.supportsTools,
    }
    if (editDraft.contextWindow === '') {
      patch.contextWindow = null
    } else {
      const ctx = Number(editDraft.contextWindow)
      if (Number.isFinite(ctx)) patch.contextWindow = ctx
    }
    updateModel.mutate({ id, patch })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <button
        type="button"
        className="flex-1 bg-black/40"
        aria-label="Close"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="w-full max-w-xl h-full bg-background border-l shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <h2 className="text-sm font-medium">
              {t('models.manage')} · {platformLabel}
            </h2>
            <p className="text-xs text-muted-foreground">{rows.length} models</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close drawer">
            <X className="size-4" />
          </Button>
        </div>

        {error && (
          <div className="mx-5 my-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Add form */}
          <div className="rounded-2xl border bg-card p-4">
            {!showAdd ? (
              <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
                + {t('models.add')}
              </Button>
            ) : (
              <form onSubmit={submitAdd} className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">modelId</Label>
                  <Input
                    value={newModelId}
                    onChange={e => setNewModelId(e.target.value)}
                    placeholder="qwen-3-coder-next-512b"
                    className="font-mono text-xs"
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">displayName</Label>
                  <Input
                    value={newDisplayName}
                    onChange={e => setNewDisplayName(e.target.value)}
                    placeholder={newModelId || t('models.add')}
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">contextWindow</Label>
                  <Input
                    value={newContextWindow}
                    onChange={e => setNewContextWindow(e.target.value)}
                    placeholder="131072"
                    type="number"
                    className="text-xs"
                  />
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={newSupportsVision} onCheckedChange={setNewSupportsVision} />
                    {t('models.vision')}
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={newSupportsTools} onCheckedChange={setNewSupportsTools} />
                    {t('models.tools')}
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={addModel.isPending || !newModelId.trim()}>
                    {addModel.isPending ? t('common.saving') : t('common.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowAdd(false)
                      setError(null)
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            )}
          </div>

          {/* List */}
          <div className="rounded-2xl border bg-card divide-y overflow-hidden">
            {rows.length === 0 ? (
              <div className="px-4 py-6 text-xs text-muted-foreground">{t('common.noData')}</div>
            ) : (
              rows.map(row => {
                const isEditing = editingId === row.id
                return (
                  <div key={row.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <SourceBadge source={row.source} />
                      <code className="text-xs font-mono flex-shrink-0 truncate">{row.modelId}</code>
                      {!isEditing && row.displayName !== row.modelId && (
                        <span className="text-xs text-muted-foreground truncate">{row.displayName}</span>
                      )}
                      <div className="flex-1" />
                      <Switch
                        checked={row.enabled}
                        onCheckedChange={v => updateModel.mutate({ id: row.id, patch: { enabled: v } })}
                        disabled={updateModel.isPending}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => (isEditing ? setEditingId(null) : startEdit(row))}
                        aria-label="Edit"
                      >
                        <Pencil className="size-3" />
                      </Button>
                      {row.source === 'user' && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className={confirmDeleteId === row.id ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}
                          onClick={() => {
                            if (confirmDeleteId === row.id) {
                              deleteModel.mutate(row.id)
                            } else {
                              setConfirmDeleteId(row.id)
                              setTimeout(() => setConfirmDeleteId(c => (c === row.id ? null : c)), 3000)
                            }
                          }}
                          disabled={deleteModel.isPending}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-3" />
                          {confirmDeleteId === row.id && (
                            <span className="ml-1">{t('keys.confirmRemove')}</span>
                          )}
                        </Button>
                      )}
                    </div>
                    {isEditing && (
                      <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border bg-muted/40 p-3">
                        <div className="space-y-1">
                          <Label className="text-xs">displayName</Label>
                          <Input
                            value={editDraft.displayName}
                            onChange={e => setEditDraft({ ...editDraft, displayName: e.target.value })}
                            className="text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">contextWindow</Label>
                          <Input
                            value={editDraft.contextWindow}
                            onChange={e => setEditDraft({ ...editDraft, contextWindow: e.target.value })}
                            type="number"
                            className="text-xs"
                          />
                        </div>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 text-xs">
                            <Switch
                              checked={editDraft.supportsVision}
                              onCheckedChange={v => setEditDraft({ ...editDraft, supportsVision: v })}
                            />
                            {t('models.vision')}
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <Switch
                              checked={editDraft.supportsTools}
                              onCheckedChange={v => setEditDraft({ ...editDraft, supportsTools: v })}
                            />
                            {t('models.tools')}
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => submitEdit(row.id)} disabled={updateModel.isPending}>
                            {updateModel.isPending ? t('common.saving') : t('common.save')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                            {t('common.cancel')}
                          </Button>
                        </div>
                      </div>
                    )}
                    {row.source !== 'user' && confirmDeleteId === row.id && (
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        {t('models.cannotDeleteCatalog')}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SourceBadge({ source }: { source: ModelRow['source'] }) {
  const { t } = useI18n()
  // The badge palette is the only place that branches on source — visually
  // anchors the row so the maintainer can scan the list and know at a glance
  // which rows accept hard-delete and which only accept disable.
  const styles: Record<ModelRow['source'], string> = {
    user: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
    catalog: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30',
    migration: 'bg-muted text-muted-foreground border-border',
  }
  const labels: Record<ModelRow['source'], string> = {
    user: t('models.sourceUser'),
    catalog: t('models.sourceCatalog'),
    migration: t('models.sourceBuiltin'),
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles[source]}`}>
      {labels[source]}
    </span>
  )
}
