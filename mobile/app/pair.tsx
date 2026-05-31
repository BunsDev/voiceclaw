import { useEffect, useState } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { Stack, useLocalSearchParams, router } from 'expo-router'
import * as Device from 'expo-device'
import { Text } from '@/components/ui/text'
import { Button } from '@/components/ui/button'
import { setSetting } from '@/db/settings'

type PairParams = {
  url?: string | string[]
  token?: string | string[]
  label?: string | string[]
  v?: string | string[]
}

type Status =
  | { kind: 'pending' }
  | { kind: 'ok'; label: string; url: string }
  | { kind: 'error'; reason: string }

function pickFirst(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export async function persistPairing(opts: {
  url: string
  token: string
  deviceName?: string
  setter?: (key: string, value: string) => Promise<void>
}): Promise<void> {
  const setter = opts.setter ?? setSetting
  await setter('realtime_server_url', opts.url)
  await setter('realtime_api_key', opts.token)
  if (opts.deviceName && opts.deviceName.trim().length > 0) {
    await setter('device_name', opts.deviceName.trim())
  }
}

export function resolveDeviceName(): string {
  const candidate = Device.deviceName || Device.modelName || ''
  return candidate.trim() || 'iPhone'
}

export async function identifyPairedDevice(opts: {
  url: string
  token: string
  deviceName: string
  // Injected for tests; defaults to a real WebSocket round-trip.
  open?: (url: string) => {
    send: (msg: string) => void
    close: () => void
    onMessage: (handler: (data: string) => void) => void
    onError: (handler: () => void) => void
    onOpen: (handler: () => void) => void
  }
}): Promise<void> {
  const opener = opts.open ?? defaultOpen
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try { sock.close() } catch { /* ignore */ }
      resolve()
    }
    const sock = opener(opts.url)
    sock.onOpen(() => {
      sock.send(JSON.stringify({
        type: 'session.auth',
        apiKey: opts.token,
        deviceName: opts.deviceName,
      }))
    })
    sock.onMessage(() => finish())
    sock.onError(() => finish())
    setTimeout(finish, 3000)
  })
}

function defaultOpen(url: string) {
  const ws = new WebSocket(url)
  return {
    send: (msg: string) => ws.send(msg),
    close: () => ws.close(),
    onMessage: (h: (data: string) => void) => { ws.onmessage = (e) => h(String(e.data)) },
    onError: (h: () => void) => { ws.onerror = () => h() },
    onOpen: (h: () => void) => { ws.onopen = () => h() },
  }
}

export default function PairScreen() {
  const params = useLocalSearchParams<PairParams>()
  const [status, setStatus] = useState<Status>({ kind: 'pending' })

  useEffect(() => {
    const url = pickFirst(params.url).trim()
    const token = pickFirst(params.token).trim()
    const label = pickFirst(params.label).trim() || 'Paired device'

    if (!url || !token) {
      setStatus({ kind: 'error', reason: 'Pairing link is missing required fields.' })
      return
    }
    if (!/^wss?:\/\//.test(url)) {
      setStatus({ kind: 'error', reason: `Pairing URL must start with ws:// or wss://, got ${url}` })
      return
    }

    const deviceName = resolveDeviceName()
    persistPairing({ url, token, deviceName })
      .then(async () => {
        try {
          await identifyPairedDevice({ url, token, deviceName })
        } catch {
          // Identify is best-effort. The row keeps its default label
          // and the user can rename from the desktop list.
        }
        setStatus({ kind: 'ok', label, url })
      })
      .catch((err) => setStatus({
        kind: 'error',
        reason: err instanceof Error ? err.message : 'Could not save pairing.',
      }))
  }, [params.url, params.token, params.label])

  return (
    <>
      <Stack.Screen options={{ title: 'Pair', headerShown: true }} />
      <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
        {status.kind === 'pending' && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground">Saving pairing…</Text>
          </>
        )}
        {status.kind === 'ok' && (
          <>
            <Text className="text-2xl font-semibold">Paired ✓</Text>
            <Text className="text-center text-sm text-muted-foreground">
              {status.label} is connected to {status.url}. Open the chat tab and start talking.
            </Text>
            <Button onPress={() => router.replace('/')}>
              <Text>Go to chat</Text>
            </Button>
          </>
        )}
        {status.kind === 'error' && (
          <>
            <Text className="text-xl font-semibold">Pairing failed</Text>
            <Text className="text-center text-sm text-muted-foreground">{status.reason}</Text>
            <Button variant="ghost" onPress={() => router.replace('/')}>
              <Text>Back</Text>
            </Button>
          </>
        )}
      </View>
    </>
  )
}
