import { spawn } from 'child_process'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { allocatePort } from '../ports'
import { resolveBundledNode } from './node-runtime'
import { serviceManager } from './service-manager'

const WARMUP_TIMEOUT_MS = 30_000

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
  await warmupIfFirstLaunch({ nodePath, scriptPath, stateDir, configPath })

  const port = await allocatePort('openclawGateway')

  await serviceManager.start({
    name: 'openclawGateway',
    command: nodePath,
    args: [scriptPath, 'gateway', '--port', String(port), '--auth', 'none', '--allow-unconfigured'],
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

// First launch on a fresh install: openclaw bakes auth tokens for the
// gateway and bundled plugins into the config, then sends itself
// SIGUSR1 to apply them. Without a supervisor it just exits, which
// trips the health-check timeout. We spawn it once headlessly until
// config stabilizes, then let serviceManager take over the steady-state.
async function warmupIfFirstLaunch(opts: {
  nodePath: string
  scriptPath: string
  stateDir: string
  configPath: string
}): Promise<void> {
  if (configHasBakedTokens(opts.configPath)) return
  await runWarmupGateway(opts)
}

function configHasBakedTokens(configPath: string): boolean {
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } }
    return typeof parsed.gateway?.auth?.token === 'string'
  } catch {
    return false
  }
}

function runWarmupGateway(opts: {
  nodePath: string
  scriptPath: string
  stateDir: string
  configPath: string
}): Promise<void> {
  return new Promise((resolve) => {
    const warmupPort = String(40000 + Math.floor(Math.random() * 1000))
    const child = spawn(
      opts.nodePath,
      [opts.scriptPath, 'gateway', '--port', warmupPort, '--auth', 'none', '--allow-unconfigured'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENCLAW_STATE_DIR: opts.stateDir,
          OPENCLAW_CONFIG_PATH: opts.configPath,
        },
        stdio: 'ignore',
        detached: false,
      },
    )
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        child.kill('SIGTERM')
      } catch {
        // already exited
      }
      resolve()
    }
    const timer = setTimeout(finish, WARMUP_TIMEOUT_MS)
    timer.unref()
    child.once('exit', finish)
  })
}
