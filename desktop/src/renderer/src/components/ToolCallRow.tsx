import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Ban } from 'lucide-react'
import type { ToolCallEntry } from '../lib/tool-call-store'

interface UpstreamDetail {
  httpStatus?: number
  httpStatusText?: string
  bodyExcerpt?: string | null
  errorClass?: string
  errorMessage?: string
  url?: string
  openclawLogHint?: string
}

function parseUpstream(raw: string): UpstreamDetail | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && 'upstream' in parsed) {
      return parsed.upstream as UpstreamDetail
    }
  } catch {
    // not JSON or no upstream field
  }
  return null
}

const RESPONSE_COLLAPSE_THRESHOLD = 800
const INLINE_ARG_TRUNCATE = 80
const STREAMING_MAX_HEIGHT = 'max-h-64'

interface ToolCallRowProps {
  entry: ToolCallEntry
}

export function ToolCallRow({ entry }: ToolCallRowProps) {
  const { status, name, args, result, error, startedAt, durationMs, step, streaming } = entry
  const errored = status === 'error'

  const [responseCollapsed, setResponseCollapsed] = useState(false)
  const [rowCollapsed, setRowCollapsed] = useState(false)
  const [upstreamExpanded, setUpstreamExpanded] = useState(errored)
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const prevStatusRef = useRef(status)

  useEffect(() => {
    if (errored) setUpstreamExpanded(true)
  }, [errored])

  // Auto-collapse when a tool transitions from in-progress to a terminal
  // state so the transcript isn't dominated by large completed payloads.
  useEffect(() => {
    if (prevStatusRef.current === 'in-progress' && status !== 'in-progress') {
      setRowCollapsed(true)
    }
    prevStatusRef.current = status
  }, [status])

  useEffect(() => {
    if (status !== 'in-progress') {
      if (intervalRef.current !== null) clearInterval(intervalRef.current)
      return
    }
    const tick = () => setElapsed(Date.now() - startedAt)
    tick()
    intervalRef.current = setInterval(tick, 200)
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current)
    }
  }, [status, startedAt])

  const responseText = errored ? (error ?? '') : (result ?? '')
  const responseLooksStructured = isStructured(responseText)
  const displayMs = status === 'in-progress' ? elapsed : (durationMs ?? 0)
  const isStreaming = status === 'in-progress' && streaming === true
  const showCollapseToggle =
    status !== 'in-progress' && responseText.length > RESPONSE_COLLAPSE_THRESHOLD
  const upstream = errored ? parseUpstream(responseText) : null

  useEffect(() => {
    if (isStreaming && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [responseText, isStreaming])

  return (
    <div className="mb-3 mx-1">
      <div
        className="rounded-md border bg-[var(--panel)]/60 px-3 py-2.5 text-xs"
        style={{
          borderColor: errored ? 'rgb(220 38 38 / 0.55)' : 'var(--line, hsl(var(--border)))',
        }}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => setRowCollapsed((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setRowCollapsed((v) => !v)
            }
          }}
          aria-expanded={!rowCollapsed}
          className="flex items-center justify-between gap-2 cursor-pointer select-none -mx-1 px-1 py-0.5 rounded hover:bg-foreground/[0.03] transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            {rowCollapsed ? (
              <ChevronRight size={12} className="text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" />
            )}
            <StatusIcon status={status} streaming={isStreaming} />
            <code className="font-mono text-[11px] text-foreground/90 truncate">{name}</code>
            {status === 'in-progress' && <ModeBadge streaming={isStreaming} />}
          </div>
          <span className={`flex-shrink-0 tabular-nums flex items-center gap-2 ${statusTextClass(status)}`}>
            <time
              dateTime={new Date(startedAt).toISOString()}
              className="text-muted-foreground/70 text-[10px] font-mono"
              title={new Date(startedAt).toLocaleString()}
            >
              {formatClockTime(startedAt)}
            </time>
            <span>{statusLabel(status)} · {formatMs(displayMs)}</span>
          </span>
        </div>

        {!rowCollapsed && (
          <>
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
            Parameters
          </div>
          <ArgsView raw={args} />
        </div>

        {(status === 'in-progress' || responseText.length > 0) && (
          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                {errored ? 'Error' : 'Response'}
              </div>
              {showCollapseToggle && (
                <button
                  type="button"
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setResponseCollapsed((v) => !v)}
                  aria-expanded={!responseCollapsed}
                >
                  {responseCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  {responseCollapsed ? 'Show full response' : 'Collapse'}
                </button>
              )}
            </div>
            {status === 'in-progress' && step && (
              <div className="mb-1 text-[11px] italic text-muted-foreground flex items-center gap-1">
                <span>{step}</span>
                <span className="inline-block w-1 h-1 rounded-full bg-current animate-pulse" />
              </div>
            )}
            <ResponseBody
              text={responseText}
              status={status}
              errored={errored}
              structured={responseLooksStructured}
              collapsed={responseCollapsed}
              streaming={isStreaming}
              streamRef={streamRef}
            />
            {upstream && (
              <div className="mt-2">
                <button
                  type="button"
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setUpstreamExpanded((v) => !v)}
                  aria-expanded={upstreamExpanded}
                >
                  {upstreamExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  What went wrong
                </button>
                {upstreamExpanded && (
                  <UpstreamPanel upstream={upstream} />
                )}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  )
}

function ResponseBody({
  text,
  status,
  errored,
  structured,
  collapsed,
  streaming,
  streamRef,
}: {
  text: string
  status: ToolCallEntry['status']
  errored: boolean
  structured: boolean
  collapsed: boolean
  streaming: boolean
  streamRef: RefObject<HTMLDivElement | null>
}) {
  if (text.length === 0) {
    if (status === 'in-progress') {
      return (
        <div className="text-[11px] text-muted-foreground/80 italic">
          Waiting for the assistant to respond
          <span className="inline-block ml-1 w-0.5 h-3 bg-current align-middle animate-pulse" />
        </div>
      )
    }
    return null
  }

  const display = collapsed ? text.slice(0, RESPONSE_COLLAPSE_THRESHOLD) + '…' : text
  const monoClass = structured ? 'font-mono text-[10px]' : 'text-[11px]'
  const accent = errored
    ? 'border-l-2 border-l-destructive bg-destructive/5'
    : 'border-l-2 border-l-[var(--accent,theme(colors.foreground/40))]'
  const scrollClass = streaming ? `${STREAMING_MAX_HEIGHT} overflow-y-auto` : ''

  return (
    <div
      ref={streamRef}
      className={`rounded-sm pl-2.5 pr-2 py-2 leading-relaxed whitespace-pre-wrap break-words ${monoClass} ${accent} ${scrollClass} ${errored ? 'text-destructive' : 'text-foreground/90'}`}
    >
      {structured ? prettyPrint(display) : display}
      {status === 'in-progress' && !errored && (
        <span className="inline-block ml-0.5 w-0.5 h-3 bg-current align-middle animate-pulse" />
      )}
    </div>
  )
}

function ArgsView({ raw }: { raw: string }) {
  const parsed = useMemo(() => tryParseObject(raw), [raw])

  if (!parsed) {
    return (
      <pre className="rounded bg-background/60 border border-border/40 p-2 font-mono text-[10px] leading-relaxed overflow-auto max-h-40 whitespace-pre-wrap break-all">
        {prettyPrint(raw)}
      </pre>
    )
  }

  const entries = Object.entries(parsed)
  if (entries.length === 0) {
    return (
      <div className="rounded bg-background/60 border border-border/40 px-2 py-1.5 text-[10px] italic text-muted-foreground/70">
        no arguments
      </div>
    )
  }

  return (
    <div className="rounded bg-background/60 border border-border/40 divide-y divide-border/30">
      {entries.map(([key, value]) => (
        <ArgRow key={key} argKey={key} value={value} />
      ))}
    </div>
  )
}

function ArgRow({ argKey, value }: { argKey: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false)
  const formatted = useMemo(() => formatArgValue(value), [value])

  if (formatted.kind === 'block') {
    const lines = formatted.text.split('\n')
    const truncated = lines.length > 6 && !expanded
    const displayed = truncated ? lines.slice(0, 6).join('\n') : formatted.text
    const canExpand = lines.length > 6
    return (
      <div className="px-2 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">
            {argKey}
          </span>
          {canExpand && (
            <button
              type="button"
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? 'collapse' : `expand (+${lines.length - 6} lines)`}
            </button>
          )}
        </div>
        <pre className="mt-1 rounded-sm bg-background/40 border border-border/30 p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words">
          {displayed}
          {truncated && <span className="text-muted-foreground/60">{'\n…'}</span>}
        </pre>
      </div>
    )
  }

  const isLong = formatted.text.length > INLINE_ARG_TRUNCATE
  const displayed =
    expanded || !isLong ? formatted.text : formatted.text.slice(0, INLINE_ARG_TRUNCATE) + '…'

  return (
    <div className="px-2 py-1 flex items-baseline gap-2">
      <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">{argKey}</span>
      <code className="font-mono text-[10px] text-foreground/90 break-all min-w-0 flex-1">
        {displayed}
      </code>
      {isLong && (
        <button
          type="button"
          className="flex-shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function UpstreamPanel({ upstream }: { upstream: UpstreamDetail }) {
  const rows: { label: string; value: string }[] = []
  if (upstream.httpStatus !== undefined) {
    rows.push({ label: 'HTTP', value: `${upstream.httpStatus} ${upstream.httpStatusText ?? ''}`.trim() })
  }
  if (upstream.errorClass) {
    rows.push({ label: 'Error', value: `${upstream.errorClass}: ${upstream.errorMessage ?? ''}` })
  }
  if (upstream.url) {
    rows.push({ label: 'URL', value: upstream.url })
  }
  if (upstream.bodyExcerpt) {
    rows.push({ label: 'Body', value: upstream.bodyExcerpt })
  }
  if (upstream.openclawLogHint) {
    rows.push({ label: 'Logs', value: upstream.openclawLogHint })
  }

  return (
    <div className="mt-1 rounded-sm border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[10px] font-mono space-y-1">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex gap-2 min-w-0">
          <span className="flex-shrink-0 text-muted-foreground w-10">{label}</span>
          <span className="text-foreground/80 break-all">{value}</span>
        </div>
      ))}
    </div>
  )
}

function ModeBadge({ streaming }: { streaming: boolean }) {
  if (streaming) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-[var(--brand-sage)]/15 px-1.5 py-[1px] text-[9px] uppercase tracking-wide text-[var(--brand-sage)]">
        <span className="inline-block w-1 h-1 rounded-full bg-[var(--brand-sage)] animate-pulse" />
        streaming
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted/40 px-1.5 py-[1px] text-[9px] uppercase tracking-wide text-muted-foreground">
      <span className="inline-block w-1 h-1 rounded-full bg-current" />
      blocking
    </span>
  )
}

function StatusIcon({
  status,
  streaming,
}: {
  status: ToolCallEntry['status']
  streaming: boolean
}) {
  switch (status) {
    case 'in-progress':
      return (
        <Loader2
          size={13}
          className={`animate-spin ${streaming ? 'text-[var(--brand-sage)]' : 'text-muted-foreground'}`}
        />
      )
    case 'success':
      return <CheckCircle2 size={13} className="text-[var(--brand-sage)]" />
    case 'error':
      return <XCircle size={13} className="text-destructive" />
    case 'cancelled':
      return <Ban size={13} className="text-muted-foreground" />
  }
}

function statusLabel(status: ToolCallEntry['status']): string {
  switch (status) {
    case 'in-progress': return 'in-progress'
    case 'success': return 'done'
    case 'error': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

function statusTextClass(status: ToolCallEntry['status']): string {
  switch (status) {
    case 'in-progress': return 'text-muted-foreground'
    case 'success': return 'text-[var(--brand-sage)]'
    case 'error': return 'text-destructive'
    case 'cancelled': return 'text-muted-foreground'
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatClockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function prettyPrint(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function isStructured(raw: string): boolean {
  if (!raw) return false
  const trimmed = raw.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // not JSON
  }
  return null
}

function formatArgValue(value: unknown): { kind: 'inline' | 'block'; text: string } {
  if (typeof value === 'string') {
    if (value.includes('\n')) return { kind: 'block', text: value }
    return { kind: 'inline', text: JSON.stringify(value) }
  }
  if (value === null) return { kind: 'inline', text: 'null' }
  if (value === undefined) return { kind: 'inline', text: 'undefined' }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'inline', text: String(value) }
  }
  try {
    const compact = JSON.stringify(value)
    if (compact && compact.length <= INLINE_ARG_TRUNCATE) {
      return { kind: 'inline', text: compact }
    }
    return { kind: 'block', text: JSON.stringify(value, null, 2) }
  } catch {
    return { kind: 'inline', text: String(value) }
  }
}
