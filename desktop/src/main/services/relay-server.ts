import { app } from 'electron'
import { existsSync } from 'fs'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'path'
import { allocatePort, getAllocatedPorts, markAllocatedPort } from '../ports'
import { getBundledRelayApiKey, getTavilyApiKey } from '../onboarding'
import { getProviderKey, type ProviderId } from '../provider-keys'
import { resolveBundledNode } from './node-runtime'
import { getDeviceTokenBridge } from './device-token-bridge'
import { getOpenClawConfigPath, readGatewayAuthToken } from './openclaw-gateway'
import { serviceManager } from './service-manager'

const PREFERRED_RELAY_PORT = 8080

export type RelaySpawnSpec = { command: string; args: string[] }

export async function startBundledRelayServer(): Promise<void> {
  const spec = resolveRelaySpawn()
  if (!spec) {
    console.info('[relay] no executable script available; skipping spawn')
    return
  }

  if (await isExternalRelayRunning(PREFERRED_RELAY_PORT)) {
    console.info(
      `[relay] external relay already serving :${PREFERRED_RELAY_PORT}; skipping spawn`,
    )
    markAllocatedPort('relay', PREFERRED_RELAY_PORT)
    return
  }

  const port = await allocatePort('relay')

  const env = buildRelayEnv()
  if (spec.command === process.execPath) {
    // Strip Electron's GUI bootstrap so the binary acts as plain Node
    // while tsx loads the relay-server TypeScript source.
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  await serviceManager.start({
    name: 'relay',
    command: spec.command,
    args: spec.args,
    env,
    port,
    healthCheckUrl: `http://127.0.0.1:${port}/health`,
    logFile: 'relay-server.log',
  })
}

export function resolveRelaySpawn(): RelaySpawnSpec | null {
  if (app.isPackaged) {
    const script = resolveBundledRelayScript()
    if (!script) return null
    const node = resolveBundledNode()
    if (!node) return null
    return { command: node, args: [script] }
  }
  // In dev, prefer a staged bundled build if present (e.g. after
  // `node scripts/build-services.mjs`), otherwise spawn the workspace
  // source via tsx so the desktop owns the relay end-to-end.
  const bundled = resolveBundledRelayScript()
  if (bundled) {
    const node = resolveBundledNode()
    if (node) return { command: node, args: [bundled] }
  }
  return resolveDevSourceRelay()
}

export function resolveBundledRelayScript(): string | null {
  const relative = join('relay-server-bundle', 'dist', 'index.js')
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, relative)
    return existsSync(packaged) ? packaged : null
  }
  const dev = join(__dirname, '..', '..', 'resources', relative)
  return existsSync(dev) ? dev : null
}

export function resolveDevSourceRelay(): RelaySpawnSpec | null {
  const repoRoot = getRepoRootInDev()
  const script = join(repoRoot, 'relay-server', 'src', 'index.ts')
  if (!existsSync(script)) return null
  // Point at tsx's CLI entry directly so the spawn does not rely on the
  // shebang line — service-manager intentionally hands children a
  // minimal env without PATH.
  const tsxCandidates = [
    join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(repoRoot, 'desktop', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ]
  const tsxCli = tsxCandidates.find((p) => existsSync(p))
  if (!tsxCli) return null
  // Re-use Electron's bundled Node by running its binary in Node mode.
  // The ELECTRON_RUN_AS_NODE env flag is set in buildRelayEnv().
  return { command: process.execPath, args: [tsxCli, script] }
}

export function buildRelayEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = forwardedEnv()
  for (const provider of Object.keys(PROVIDER_ENV_KEYS) as ProviderId[]) {
    const envKey = PROVIDER_ENV_KEYS[provider]
    if (env[envKey]) continue
    const stored = getProviderKey(provider)
    if (stored) env[envKey] = stored
  }
  if (!env.BRAIN_GATEWAY_AUTH_TOKEN) {
    const token = readGatewayAuthToken(getOpenClawConfigPath())
    if (token) env.BRAIN_GATEWAY_AUTH_TOKEN = token
  }
  if (!env.RELAY_API_KEY) {
    const bundledKey = getBundledRelayApiKey()
    if (bundledKey) env.RELAY_API_KEY = bundledKey
  }
  if (!env.BRAIN_GATEWAY_URL) {
    const openclawPort = getAllocatedPorts().openclawGateway
    if (openclawPort) env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${openclawPort}`
  }
  if (!env.TAVILY_API_KEY) {
    const stored = getTavilyApiKey()
    if (stored) env.TAVILY_API_KEY = stored
  }
  // Desktop-managed relay still needs to be reachable on the tailnet so the
  // paired mobile app can connect. The relay now defaults to 127.0.0.1 to
  // close the open-WS-on-LAN gap; we re-open it here because the desktop also
  // ensures RELAY_API_KEY is provisioned in buildRelayEnv (above), so the
  // tailnet socket is only reachable with the bundled key.
  if (!env.RELAY_BIND_HOST) env.RELAY_BIND_HOST = "0.0.0.0"
  // Per-device token validation runs through the localhost bridge owned by
  // the desktop main process. Missing env vars => the relay falls back to
  // the master-key path only (which is what standalone `yarn dev` wants).
  const bridge = getDeviceTokenBridge()
  if (bridge) {
    if (!env.VOICECLAW_DEVICE_TOKEN_CHECK_URL) env.VOICECLAW_DEVICE_TOKEN_CHECK_URL = bridge.url
    if (!env.VOICECLAW_DEVICE_TOKEN_CHECK_NONCE) env.VOICECLAW_DEVICE_TOKEN_CHECK_NONCE = bridge.nonce
  }
  return env
}

// Build the ws:// URL a paired mobile device should connect to. The relay
// binds 0.0.0.0 (see RELAY_BIND_HOST above), but the QR payload needs a
// concrete host the phone can reach. We prefer the Tailscale CGNAT
// address (100.64.0.0/10) because the household pairing model assumes
// both ends are on the tailnet — that's the only IP guaranteed to be
// stable across cafes / hotel Wi-Fi. Fall back to the first non-internal
// IPv4 (LAN) so dev-mode pairing still works without Tailscale running.
// Returns `null` only when neither path turns up a usable host (e.g.
// fully offline laptop with no interfaces up).
export function getTailnetUrl(
  interfacesFn: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): string | null {
  const port = getAllocatedPorts().relay ?? PREFERRED_RELAY_PORT
  const host = pickPairingHost(interfacesFn())
  if (!host) return null
  return `ws://${host}:${port}/ws`
}

function pickPairingHost(
  ifaces: ReturnType<typeof networkInterfaces>,
): string | null {
  let lanFallback: string | null = null
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name]
    if (!list) continue
    for (const entry of list) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (isTailnetAddress(entry.address)) return entry.address
      if (!lanFallback) lanFallback = entry.address
    }
  }
  return lanFallback
}

function isTailnetAddress(address: string): boolean {
  // CGNAT block 100.64.0.0/10 — Tailscale picks from this range.
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const first = Number(parts[0])
  const second = Number(parts[1])
  if (first !== 100) return false
  return second >= 64 && second <= 127
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORWARDED_KEYS = [
  'TAVILY_API_KEY',
  'BRAIN_GATEWAY_URL',
  'BRAIN_GATEWAY_AUTH_TOKEN',
  'RELAY_API_KEY',
  'RELAY_BIND_HOST',
  'RELAY_ALLOW_UNAUTHENTICATED',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'TRACING_UI_COLLECTOR_URL',
  'GIT_SHA',
  'RELAY_VERSION',
  'VOICECLAW_WORKSPACE',
  'VOICECLAW_DEVICE_TOKEN_CHECK_URL',
  'VOICECLAW_DEVICE_TOKEN_CHECK_NONCE',
] as const

const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
}

function forwardedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of FORWARDED_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

// Electron-vite emits main to <repo>/desktop/out/main, so __dirname is
// three levels under the repo root in dev. Packaged builds never call
// this — they take the bundled-script path instead.
function getRepoRootInDev(): string {
  return join(__dirname, '..', '..', '..')
}

function isExternalRelayRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        method: 'GET',
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: 500,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}
