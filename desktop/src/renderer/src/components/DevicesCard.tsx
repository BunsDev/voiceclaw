import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import type { DeviceCreateResult, DeviceListRow } from '../lib/db'
import { buildDefaultLabel, buildPairDeeplink, DEFAULT_MOBILE_SCHEME } from '../lib/pair'

type PairingState =
  | { kind: 'idle' }
  | { kind: 'minting'; label: string }
  | { kind: 'error'; error: string }
  | {
      kind: 'paired'
      created: Extract<DeviceCreateResult, { ok: true }>
      qrDataUrl: string
      deeplink: string
      label: string
      labelDirty: boolean
      copied: 'token' | 'url' | null
      confirmed: boolean
    }

// Mobile URL scheme to embed in the QR deeplink. Default targets the
// staging TestFlight build (`voiceclaw-staging`); flip via Vite env
// when staging is promoted to prod. Dev builds use `voiceclaw-dev`.
function getMobileScheme(): string {
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_VOICECLAW_MOBILE_SCHEME
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MOBILE_SCHEME
}

export function DevicesCard() {
  const [devices, setDevices] = useState<DeviceListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [pairing, setPairing] = useState<PairingState>({ kind: 'idle' })
  const [renameTarget, setRenameTarget] = useState<{ id: string; label: string } | null>(null)

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.devices
    if (!api) {
      setListError('Device pairing bridge unavailable.')
      setLoading(false)
      return
    }
    try {
      const list = await api.list()
      setDevices(list)
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load devices.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Race-guard: rapid Pair → Cancel → Pair must never paste the first
  // token into the second modal. We bump a counter on every open and
  // ignore async results whose counter no longer matches.
  const pairAttemptRef = useRef(0)

  const startPairing = useCallback(async () => {
    const api = window.electronAPI?.devices
    if (!api) {
      setPairing({ kind: 'error', error: 'Device pairing bridge unavailable.' })
      return
    }
    const attempt = ++pairAttemptRef.current
    const label = buildDefaultLabel()
    setPairing({ kind: 'minting', label })
    try {
      const result = await api.create(label)
      if (pairAttemptRef.current !== attempt) {
        if (result.ok) void api.revoke(result.id).catch(() => {})
        return
      }
      if (!result.ok) {
        setPairing({ kind: 'error', error: result.error })
        return
      }
      const deeplink = buildPairDeeplink(getMobileScheme(), {
        url: result.payload.url,
        token: result.plaintext,
        label: result.label,
      })
      const qrDataUrl = await QRCode.toDataURL(deeplink, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6,
        color: { dark: '#000000', light: '#ffffff' },
      })
      if (pairAttemptRef.current !== attempt) {
        void api.revoke(result.id).catch(() => {})
        return
      }
      setPairing({
        kind: 'paired',
        created: result,
        qrDataUrl,
        deeplink,
        label: result.label,
        labelDirty: false,
        copied: null,
        confirmed: false,
      })
      await refresh()
    } catch (err) {
      if (pairAttemptRef.current !== attempt) return
      setPairing({
        kind: 'error',
        error: err instanceof Error ? err.message : 'Could not create device.',
      })
    }
  }, [refresh])

  // Cancel = user backed out without saying "Done". Auto-revoke the
  // pending token so we don't leak orphan rows.
  const cancelPairing = useCallback(() => {
    pairAttemptRef.current++
    setPairing((prev) => {
      if (prev.kind === 'paired' && !prev.confirmed) {
        const api = window.electronAPI?.devices
        if (api) {
          void api.revoke(prev.created.id).then(() => refresh()).catch(() => {})
        }
      }
      return { kind: 'idle' }
    })
  }, [refresh])

  const confirmPairing = useCallback(() => {
    setPairing((prev) => (prev.kind === 'paired' ? { ...prev, confirmed: true } : prev))
    setPairing({ kind: 'idle' })
  }, [])

  // Inline label edit while the QR modal is open. The renamed label
  // is persisted via the existing devices:rename IPC so the row in the
  // list stays in sync, and the deeplink/QR are regenerated.
  const updatePairLabel = useCallback(async (next: string) => {
    setPairing((p) => (p.kind === 'paired' ? { ...p, label: next, labelDirty: true } : p))
  }, [])

  const commitPairLabel = useCallback(async () => {
    const api = window.electronAPI?.devices
    if (!api) return
    let current: Extract<PairingState, { kind: 'paired' }> | null = null
    setPairing((p) => {
      if (p.kind === 'paired') current = p
      return p
    })
    if (!current) return
    const trimmed = current.label.trim()
    if (trimmed.length === 0 || trimmed === current.created.label) return
    const result = await api.rename(current.created.id, trimmed)
    if (!result.ok) {
      setPairing((p) => (p.kind === 'paired' ? { ...p, label: p.created.label, labelDirty: false } : p))
      return
    }
    const deeplink = buildPairDeeplink(getMobileScheme(), {
      url: current.created.payload.url,
      token: current.created.plaintext,
      label: trimmed,
    })
    try {
      const qrDataUrl = await QRCode.toDataURL(deeplink, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6,
        color: { dark: '#000000', light: '#ffffff' },
      })
      setPairing((p) =>
        p.kind === 'paired'
          ? {
              ...p,
              deeplink,
              qrDataUrl,
              label: trimmed,
              labelDirty: false,
              created: { ...p.created, label: trimmed },
            }
          : p,
      )
      await refresh()
    } catch {
      // QR regen failure is non-fatal — keep the previous QR.
    }
  }, [refresh])

  const copyText = useCallback(async (text: string, which: 'token' | 'url') => {
    try {
      await navigator.clipboard.writeText(text)
      setPairing((p) => (p.kind === 'paired' ? { ...p, copied: which } : p))
      setTimeout(() => {
        setPairing((p) => (p.kind === 'paired' && p.copied === which ? { ...p, copied: null } : p))
      }, 1800)
    } catch {
      // Clipboard unavailable — silently skip; the field is still selectable.
    }
  }, [])

  const handleRevoke = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.devices
      if (!api) return
      const result = await api.revoke(id)
      if (result.ok) await refresh()
      else setListError(result.error)
    },
    [refresh],
  )

  const handleRemove = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.devices
      if (!api) return
      const result = await api.remove(id)
      if (result.ok) await refresh()
      else setListError(result.error)
    },
    [refresh],
  )

  const handleRename = useCallback(
    async (id: string, label: string) => {
      const api = window.electronAPI?.devices
      if (!api) return
      const trimmed = label.trim()
      if (trimmed.length === 0) {
        setListError('Label cannot be empty.')
        return
      }
      const result = await api.rename(id, trimmed)
      if (result.ok) {
        setRenameTarget(null)
        await refresh()
      } else {
        setListError(result.error)
      }
    },
    [refresh],
  )

  return (
    <>
      <Card className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Devices</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Phones and tablets paired to this Mac. Each device gets its own token —
              revoke one without affecting the others.
            </p>
          </div>
          <Button variant="default" size="sm" onClick={() => void startPairing()}>
            Pair a device
          </Button>
        </div>

        {listError && (
          <p className="text-xs text-destructive" role="alert">
            {listError}
          </p>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No devices paired yet. Tap “Pair a device” to scan a QR from the mobile app.
          </p>
        ) : (
          <ul className="divide-y divide-input rounded-md border border-input overflow-hidden">
            {devices.map((d) => (
              <li key={d.id} className="px-3 py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  {renameTarget?.id === d.id ? (
                    <RenameRow
                      label={renameTarget.label}
                      onChange={(v) => setRenameTarget({ id: d.id, label: v })}
                      onSubmit={() => void handleRename(d.id, renameTarget.label)}
                      onCancel={() => setRenameTarget(null)}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground truncate">{d.label}</p>
                        {d.revoked && (
                          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive">
                            Revoked
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Last seen {formatLastSeen(d.lastUsedAt)}
                      </p>
                    </>
                  )}
                </div>
                {renameTarget?.id !== d.id && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRenameTarget({ id: d.id, label: d.label })}
                    >
                      Rename
                    </Button>
                    {!d.revoked && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRevoke(d.id)}
                      >
                        Revoke
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRemove(d.id)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pairing.kind === 'minting' && (
        <ModalShell onClose={cancelPairing}>
          <h4 className="text-sm font-semibold text-foreground">Pair a device</h4>
          <p className="text-xs text-muted-foreground">Generating QR…</p>
        </ModalShell>
      )}

      {pairing.kind === 'error' && (
        <ModalShell onClose={cancelPairing}>
          <h4 className="text-sm font-semibold text-foreground">Pair a device</h4>
          <p className="text-xs text-destructive" role="alert">{pairing.error}</p>
          <div className="flex justify-end pt-2">
            <Button variant="default" size="sm" onClick={cancelPairing}>Close</Button>
          </div>
        </ModalShell>
      )}

      {pairing.kind === 'paired' && (
        <PairQrModal
          created={pairing.created}
          qrDataUrl={pairing.qrDataUrl}
          deeplink={pairing.deeplink}
          label={pairing.label}
          copied={pairing.copied}
          onLabelChange={(v) => void updatePairLabel(v)}
          onLabelCommit={() => void commitPairLabel()}
          onCopy={(text, which) => void copyText(text, which)}
          onCancel={cancelPairing}
          onConfirm={confirmPairing}
        />
      )}
    </>
  )
}

function RenameRow({
  label,
  onChange,
  onSubmit,
  onCancel,
}: {
  label: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        value={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
          else if (e.key === 'Escape') onCancel()
        }}
        className="text-sm"
      />
      <Button variant="outline" size="sm" onClick={onSubmit}>
        Save
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

function PairQrModal({
  created,
  qrDataUrl,
  deeplink,
  label,
  copied,
  onLabelChange,
  onLabelCommit,
  onCopy,
  onCancel,
  onConfirm,
}: {
  created: Extract<DeviceCreateResult, { ok: true }>
  qrDataUrl: string
  deeplink: string
  label: string
  copied: 'token' | 'url' | null
  onLabelChange: (v: string) => void
  onLabelCommit: () => void
  onCopy: (text: string, which: 'token' | 'url') => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ModalShell onClose={onCancel}>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-foreground">Pair a device</h4>
        <p className="text-xs text-muted-foreground">
          Scan with your iPhone's Camera app — tap the prompt to open VoiceClaw and
          finish pairing. The token is shown once; copy it for a manual fallback.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Device name</label>
        <Input
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          onBlur={() => onLabelCommit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          placeholder="iPhone 15"
        />
      </div>

      <div className="flex justify-center">
        <img
          src={qrDataUrl}
          alt={`Pairing QR for ${created.label}`}
          className="rounded-md border border-input bg-white p-2"
          style={{ width: 220, height: 220 }}
        />
      </div>

      {!created.hasNetwork && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Couldn't detect a Tailscale or LAN address. The QR contains an empty URL —
          your phone won't be able to reach this Mac until networking is up.
        </p>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Token (shown once — copy now)</label>
          <button
            type="button"
            onClick={() => onCopy(created.plaintext, 'token')}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {copied === 'token' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <code className="block break-all rounded-md border border-input bg-muted px-3 py-2 text-[11px] font-mono text-foreground select-all">
          {created.plaintext}
        </code>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Pairing link</label>
          <button
            type="button"
            onClick={() => onCopy(deeplink, 'url')}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            disabled={!deeplink}
          >
            {copied === 'url' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <code className="block break-all rounded-md border border-input bg-muted px-3 py-2 text-[11px] font-mono text-foreground select-all">
          {deeplink || '(no network detected)'}
        </code>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="default" size="sm" onClick={onConfirm}>
          Done
        </Button>
      </div>
    </ModalShell>
  )
}

function ModalShell({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-input bg-background p-5 space-y-3 shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  )
}

function formatLastSeen(ts: number | null): string {
  if (ts === null) return 'never'
  const diff = Math.round((Date.now() - ts) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}
