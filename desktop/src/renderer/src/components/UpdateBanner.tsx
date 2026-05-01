import { useEffect, useState } from 'react'

type StagedPayload = {
  version: string
  releaseNotes: string | null
}

export function UpdateBanner() {
  const [staged, setStaged] = useState<StagedPayload | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const api = window.electronAPI?.updates
    if (!api) return

    api.getState().then((s) => {
      if (s.status === 'staged' && s.stagedVersion) {
        setStaged({ version: s.stagedVersion, releaseNotes: s.releaseNotes })
      }
    }).catch(() => {})

    const removeStaged = api.onStaged((payload) => {
      setStaged(payload)
      setDismissed(false)
    })

    const removeStateChanged = api.onStateChanged((s) => {
      if (s.stagedVersion) {
        setStaged({ version: s.stagedVersion, releaseNotes: s.releaseNotes })
      } else {
        setStaged(null)
      }
    })

    return () => {
      removeStaged()
      removeStateChanged()
    }
  }, [])

  if (!staged || dismissed) return null

  const handleInstall = async () => {
    setInstalling(true)
    await window.electronAPI.updates.installNow('banner')
  }

  return (
    <div className="flex flex-col bg-[var(--brand-sage)] text-white text-sm">
      <div className="flex items-center justify-between px-3 py-1.5 gap-2">
        <span className="font-medium shrink-0">
          Update ready: {staged.version}
        </span>
        <div className="flex items-center gap-1.5 ml-auto">
          {staged.releaseNotes && (
            <button
              onClick={() => setShowNotes((v) => !v)}
              className="px-2 py-0.5 rounded text-xs bg-white/20 hover:bg-white/30 transition-colors whitespace-nowrap"
            >
              {showNotes ? 'Hide notes ▴' : "What's new ▾"}
            </button>
          )}
          <button
            onClick={() => setDismissed(true)}
            className="px-2 py-0.5 rounded text-xs bg-white/20 hover:bg-white/30 transition-colors"
          >
            Later
          </button>
          <button
            onClick={handleInstall}
            disabled={installing}
            className="px-2 py-0.5 rounded text-xs bg-white text-[var(--brand-sage)] font-semibold hover:bg-white/90 transition-colors disabled:opacity-60"
          >
            {installing ? 'Restarting…' : 'Restart now'}
          </button>
        </div>
      </div>
      {showNotes && staged.releaseNotes && (
        <div className="px-3 pb-2 text-xs text-white/90 whitespace-pre-wrap border-t border-white/20 pt-1.5 max-h-40 overflow-y-auto">
          {staged.releaseNotes}
        </div>
      )}
    </div>
  )
}
