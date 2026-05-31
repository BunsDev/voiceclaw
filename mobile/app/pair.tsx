import { useEffect, useState } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { Stack, useLocalSearchParams, router } from 'expo-router'
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
  setter?: (key: string, value: string) => Promise<void>
}): Promise<void> {
  const setter = opts.setter ?? setSetting
  await setter('realtime_server_url', opts.url)
  await setter('realtime_api_key', opts.token)
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

    persistPairing({ url, token })
      .then(() => setStatus({ kind: 'ok', label, url }))
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
