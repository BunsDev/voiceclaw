import { BRAND, type BrandPalette } from '@/lib/brand'
import { useColorScheme } from 'nativewind'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  UIManager,
  View,
} from 'react-native'
import { Text } from '@/components/ui/text'

if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true)
}

export type ToolCallStatus = 'in-progress' | 'success' | 'error' | 'cancelled' | 'stopped'

export interface ToolCallItem {
  callId: string
  name: string
  args: string
  status: ToolCallStatus
  startedAt: number
  durationMs?: number
  result?: string
  error?: string
  progressText?: string
  progressStep?: string
}

interface ToolCallRowProps {
  item: ToolCallItem
}

export function ToolCallRow({ item }: ToolCallRowProps) {
  const { colorScheme } = useColorScheme()
  const palette = colorScheme === 'dark' ? BRAND.colors.dark : BRAND.colors.light
  const [expanded, setExpanded] = useState(item.status === 'error')
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (item.status !== 'in-progress') {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }
    intervalRef.current = setInterval(() => {
      setElapsed(Date.now() - item.startedAt)
    }, 250)
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [item.status, item.startedAt])

  useEffect(() => {
    if (item.status === 'error' && !expanded) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
      setExpanded(true)
    }
  }, [item.status])

  const hasProgressText = !!item.progressText && item.progressText.length > 0
  const allowInProgressExpand = item.status === 'in-progress' && hasProgressText

  const toggleExpanded = useCallback(() => {
    if (item.status === 'in-progress' && !hasProgressText) return
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setExpanded((v) => !v)
  }, [item.status, hasProgressText])

  const displayDuration = item.durationMs != null
    ? formatDuration(item.durationMs)
    : item.status === 'in-progress'
    ? formatDuration(elapsed)
    : null

  const argsSummary = summarizeArgs(item.args)
  const canExpand =
    item.status === 'success' ||
    item.status === 'error' ||
    allowInProgressExpand

  return (
    <Pressable
      onPress={toggleExpanded}
      disabled={!canExpand}
      accessibilityRole="button"
      accessibilityLabel={`Tool call ${item.name}, status ${item.status}`}
      style={{ paddingHorizontal: 16, marginBottom: 8 }}
    >
      <View
        style={{
          borderRadius: 8,
          borderWidth: 1,
          borderColor: borderColor(item.status, palette),
          backgroundColor: bgColor(item.status, palette, colorScheme === 'dark'),
          paddingHorizontal: 12,
          paddingVertical: 10,
          overflow: 'hidden',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusIcon status={item.status} palette={palette} />
          <Text
            style={{
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              fontSize: 13,
              fontWeight: '500',
              color: palette.ink,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {item.name}
          </Text>
          {displayDuration != null && (
            <Text
              style={{ fontSize: 11, color: palette.muted, marginLeft: 'auto', flexShrink: 0 }}
              numberOfLines={1}
            >
              {displayDuration}
            </Text>
          )}
          {canExpand && (
            <Text style={{ fontSize: 11, color: palette.muted, marginLeft: displayDuration ? 4 : 'auto' }}>
              {expanded ? '▲' : '▼'}
            </Text>
          )}
        </View>

        {argsSummary ? (
          <Text
            style={{ fontSize: 12, color: palette.muted, marginTop: 4 }}
            numberOfLines={expanded ? undefined : 1}
          >
            {argsSummary}
          </Text>
        ) : null}

        {item.status === 'in-progress' && item.progressStep ? (
          <Text
            style={{
              fontSize: 11,
              color: palette.muted,
              fontStyle: 'italic',
              marginTop: 4,
            }}
            numberOfLines={1}
          >
            {item.progressStep}
          </Text>
        ) : null}

        {item.status === 'in-progress' && !expanded && hasProgressText ? (
          <Text style={{ fontSize: 11, color: palette.muted, marginTop: 4 }} numberOfLines={1}>
            ▸ streaming…
          </Text>
        ) : null}

        {expanded && hasProgressText && (
          <ExpandedContent
            label={item.status === 'in-progress' ? 'Streaming' : 'Progress'}
            content={item.progressText!}
            palette={palette}
            tail
          />
        )}

        {expanded && item.status === 'success' && item.result != null && (
          <ExpandedContent label="Result" content={item.result} palette={palette} />
        )}

        {expanded && item.status === 'error' && item.error != null && (
          <ExpandedContent label="Error" content={item.error} palette={palette} isError />
        )}
      </View>
    </Pressable>
  )
}

function ExpandedContent({
  label,
  content,
  palette,
  isError = false,
  tail = false,
}: {
  label: string
  content: string
  palette: BrandPalette
  isError?: boolean
  tail?: boolean
}) {
  const scrollRef = useRef<ScrollView | null>(null)
  const displayContent = tail ? content : prettyPrint(content)

  useEffect(() => {
    if (!tail) return
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 0)
    return () => clearTimeout(id)
  }, [tail, displayContent])

  return (
    <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: palette.line, paddingTop: 8 }}>
      <Text style={{ fontSize: 10, color: palette.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Text>
      <ScrollView ref={scrollRef} style={{ maxHeight: 200 }} nestedScrollEnabled>
        <Text
          selectable
          style={{
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            fontSize: 11,
            color: isError ? palette.destructive : palette.ink,
            lineHeight: 16,
          }}
        >
          {displayContent}
        </Text>
      </ScrollView>
    </View>
  )
}

function StatusIcon({ status, palette }: { status: ToolCallStatus, palette: BrandPalette }) {
  if (status === 'in-progress') {
    return <ActivityIndicator size="small" color={palette.muted} style={{ width: 16, height: 16 }} />
  }
  const icon = status === 'success' ? '✓' : status === 'error' ? '✕' : status === 'stopped' ? '◼' : '—'
  const color = status === 'success' ? palette.sage : status === 'error' ? palette.destructive : palette.muted
  return (
    <Text style={{ fontSize: 13, color, fontWeight: '600', width: 16, textAlign: 'center' }}>
      {icon}
    </Text>
  )
}

// --- Helper Functions ---

function borderColor(status: ToolCallStatus, palette: BrandPalette): string {
  if (status === 'error') return palette.destructive + '60'
  if (status === 'success') return palette.sage + '60'
  return palette.lineStrong
}

function bgColor(status: ToolCallStatus, palette: BrandPalette, dark: boolean): string {
  if (status === 'error') return dark ? 'rgba(248,113,113,0.08)' : 'rgba(239,68,68,0.05)'
  if (status === 'success') return dark ? 'rgba(156,172,153,0.08)' : 'rgba(105,118,104,0.06)'
  return palette.panel
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function summarizeArgs(args: string): string {
  try {
    const parsed = JSON.parse(args)
    const entries = Object.entries(parsed)
    if (entries.length === 0) return ''
    const [key, value] = entries[0]
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    const truncated = str.length > 80 ? str.slice(0, 80) + '…' : str
    return entries.length === 1 ? truncated : `${key}: ${truncated}`
  } catch {
    return args.length > 80 ? args.slice(0, 80) + '…' : args
  }
}

function prettyPrint(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}
