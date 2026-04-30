import { app } from 'electron'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { allocatePort } from '../ports'
import { openLogStream } from '../logs'
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
  const workspaceDir = join(stateDir, 'workspace')
  ensureSeededConfig(configPath)
  ensureGatewayAuthToken(configPath)
  await ensureWorkspaceBootstrap({
    nodePath,
    scriptPath,
    stateDir,
    configPath,
    workspaceDir,
  })

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

export const BUNDLED_GOOGLE_PRIMARY_MODEL = 'google/gemini-3.1-pro-preview'

export function applyGeminiKeyToOpenClawConfig(geminiKey: string): boolean {
  const configPath = getOpenClawConfigPath()
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

  const before = JSON.stringify(parsed)

  const models = (parsed.models as Record<string, unknown> | undefined) ?? {}
  const providers = (models.providers as Record<string, unknown> | undefined) ?? {}
  const google = (providers.google as Record<string, unknown> | undefined) ?? {}
  google.apiKey = geminiKey
  providers.google = google
  models.providers = providers
  if (typeof models.mode !== 'string') models.mode = 'merge'
  parsed.models = models

  const agents = (parsed.agents as Record<string, unknown> | undefined) ?? {}
  const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {}
  const existingModel = defaults.model as Record<string, unknown> | string | undefined
  const fallbacks =
    existingModel && typeof existingModel === 'object' && Array.isArray(existingModel.fallbacks)
      ? (existingModel.fallbacks as unknown[])
      : undefined
  defaults.model = {
    ...(fallbacks ? { fallbacks } : {}),
    primary: BUNDLED_GOOGLE_PRIMARY_MODEL,
  }
  agents.defaults = defaults
  parsed.agents = agents

  const plugins = (parsed.plugins as Record<string, unknown> | undefined) ?? {}
  const entries = (plugins.entries as Record<string, unknown> | undefined) ?? {}
  const googlePlugin = (entries.google as Record<string, unknown> | undefined) ?? {}
  googlePlugin.enabled = true
  entries.google = googlePlugin
  plugins.entries = entries
  parsed.plugins = plugins

  const after = JSON.stringify(parsed)
  if (before === after) return false
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
  return true
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

async function ensureWorkspaceBootstrap(params: {
  nodePath: string
  scriptPath: string
  stateDir: string
  configPath: string
  workspaceDir: string
}): Promise<void> {
  const sentinelPath = join(params.stateDir, 'workspace-bootstrapped')
  if (existsSync(sentinelPath)) return
  if (existsSync(join(params.workspaceDir, 'IDENTITY.md'))) {
    writeFileSync(sentinelPath, new Date().toISOString() + '\n')
    return
  }
  mkdirSync(params.workspaceDir, { recursive: true })
  const logStream = openLogStream('openclaw-setup.log')
  logStream.write(`\n[openclaw-setup] running setup at ${new Date().toISOString()}\n`)
  await new Promise<void>((resolve) => {
    const child = spawn(
      params.nodePath,
      [params.scriptPath, 'setup', '--workspace', params.workspaceDir],
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: params.stateDir,
          OPENCLAW_CONFIG_PATH: params.configPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      },
    )
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })
    let settled = false
    const settle = (note: string) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      logStream.write(`\n[openclaw-setup] ${note}\n`)
      resolve()
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // best-effort
      }
      settle('timed out after 30s; gateway will still start with partial bootstrap')
    }, 30_000)
    killTimer.unref()
    child.once('error', (err) => settle(`spawn error: ${err.message}`))
    child.once('exit', (code) => settle(`exit code=${code ?? 'null'}`))
  })
  if (existsSync(join(params.workspaceDir, 'IDENTITY.md'))) {
    writeFileSync(sentinelPath, new Date().toISOString() + '\n')
  }
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
