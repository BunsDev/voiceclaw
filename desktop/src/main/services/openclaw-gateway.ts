import { app } from 'electron'
import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { allocatePort } from '../ports'
import { resolveBundledNode } from './node-runtime'
import { serviceManager } from './service-manager'

export async function startBundledOpenClaw(): Promise<void> {
  const scriptPath = resolveBundledOpenClawScript()
  if (!scriptPath) {
    console.info('[openclaw] bundled script not found; skipping spawn')
    return
  }
  const nodePath = resolveBundledNode()
  if (!nodePath) {
    console.info('[openclaw] bundled node runtime not found; skipping spawn')
    return
  }

  const stateDir = join(app.getPath('userData'), 'openclaw')
  const configPath = join(stateDir, 'openclaw.json')
  ensureSeededConfig(configPath)
  ensureGatewayAuthToken(configPath)

  const port = await allocatePort('openclawGateway')

  await serviceManager.start({
    name: 'openclawGateway',
    command: nodePath,
    args: [scriptPath, 'gateway', '--port', String(port)],
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    },
    port,
    healthCheckUrl: `http://127.0.0.1:${port}/health`,
    healthCheckTimeoutMs: 30_000,
    logFile: 'openclaw-gateway.log',
  })
}

export function resolveBundledOpenClawScript(): string | null {
  const relative = join('openclaw', 'openclaw.mjs')
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, relative)
    return existsSync(packaged) ? packaged : null
  }
  const dev = join(__dirname, '..', '..', '..', 'vendor', 'openclaw', 'openclaw.mjs')
  return existsSync(dev) ? dev : null
}

export function readGatewayAuthToken(configPath: string): string | null {
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } }
    const token = parsed.gateway?.auth?.token
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function getOpenClawConfigPath(): string {
  return join(app.getPath('userData'), 'openclaw', 'openclaw.json')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureSeededConfig(configPath: string): void {
  if (existsSync(configPath)) return
  const template = resolveConfigTemplate()
  if (!template) {
    console.warn('[openclaw] config template missing; gateway will bootstrap from defaults')
    return
  }
  mkdirSync(dirname(configPath), { recursive: true })
  copyFileSync(template, configPath)
}

function resolveConfigTemplate(): string | null {
  const relative = 'openclaw-config-template.json'
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, relative)
    return existsSync(packaged) ? packaged : null
  }
  const dev = join(__dirname, '..', '..', 'resources', relative)
  return existsSync(dev) ? dev : null
}

// Mints a random gateway token on first launch and persists it under
// gateway.auth.token. The relay reads the same file to populate
// BRAIN_GATEWAY_AUTH_TOKEN, so both ends share one secret without ever
// shipping a hardcoded default and without leaving the gateway open via
// --auth none on loopback.
function ensureGatewayAuthToken(configPath: string): void {
  let parsed: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    } catch {
      parsed = {}
    }
  } else {
    mkdirSync(dirname(configPath), { recursive: true })
  }
  const gateway = (parsed.gateway as Record<string, unknown> | undefined) ?? {}
  const auth = (gateway.auth as Record<string, unknown> | undefined) ?? {}
  if (typeof auth.token === 'string' && auth.token.length > 0 && auth.mode === 'token') return

  auth.mode = 'token'
  if (typeof auth.token !== 'string' || auth.token.length === 0) {
    auth.token = randomUUID()
  }
  gateway.auth = auth
  parsed.gateway = gateway
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
}
