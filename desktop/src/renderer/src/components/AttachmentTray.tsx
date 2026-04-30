import { Send, X } from 'lucide-react'
import type { PendingAttachment } from '../lib/attachments'
import { Button } from './ui/Button'

interface AttachmentTrayProps {
  pending: PendingAttachment[]
  onRemove: (id: string) => void
  onSend: () => void
  sending: boolean
}

export function AttachmentTray({ pending, onRemove, onSend, sending }: AttachmentTrayProps) {
  if (pending.length === 0) return null
  return (
    <div className="px-4 py-2 border-t border-border bg-background/65">
      <div className="flex items-end gap-3">
        <div className="flex flex-wrap gap-2 flex-1">
          {pending.map((p) => (
            <div key={p.id} className="relative group">
              <img
                src={p.previewUrl}
                alt={p.originalName ?? 'pending attachment'}
                className="w-16 h-16 object-cover rounded-md border border-border"
              />
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => onRemove(p.id)}
                className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <Button onClick={onSend} disabled={sending} size="sm">
          <Send size={14} className="mr-1" />
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
