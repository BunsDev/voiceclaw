import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import type { WriteStream } from 'fs'
import { request as httpRequest } from 'node:http'
import type { ServiceName } from '../ports'
import { openLogStream } from '../logs'

// Central lifecycle for the bundled services. Keeps one source of truth
// for start / stop / health / logs so the menu bar, renderer, and
// shutdown handlers all see the same state.

export type ServiceStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'running'; port: number; startedAt: number }
  | { state: 'crashed'; lastExitCode: number | null; startedAt: number }
  | { state: 'failed'; reason: string; startedAt: number }
  | { state: 'stopped' }

export type ServiceDefinition = {
  name: ServiceName
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  port: number
  healthCheckUrl?: string
  healthCheckTimeoutMs?: number
  logFile: string
}

type ServiceState = {
  definition: ServiceDefinition
  status: ServiceStatus
  child: ChildProcess | null
}

const HEALTH_POLL_INTERVAL_MS = 200
const HEALTH_TIMEOUT_MS_DEFAULT = 10_000

class ServiceManager extends EventEmitter {
  private services = new Map<ServiceName, ServiceState>()
  private restartChain: Promise<void> = Promise.resolve()

  async start(def: ServiceDefinition): Promise<void> {
    const existing = this.services.get(def.name)
    if (existing && existing.status.state === 'running') {
      return
    }

    const state: ServiceState = {
      definition: def,
      status: { state: 'starting' },
      child: null,
    }
    this.services.set(def.name, state)
    this.emit('change', def.name, state.status)

    const logStream = openLogStream(def.logFile)
    // Opt-in env only: process.env passthrough would defeat the
    // explicit allowlist callers built up in their own def.env.
    const child = spawn(def.command, def.args ?? [], {
      env: { ...(def.env ?? {}), PORT: String(def.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
    state.child = child

    child.once('error', (err) => {
      logStream.write(`\n[service-manager] ${def.name} failed to spawn: ${err.message}\n`)
      this.setStatus(def.name, { state: 'crashed', lastExitCode: null, startedAt: Date.now() })
    })

    child.once('exit', (code) => {
      const current = this.services.get(def.name)
      if (!current) return
      if (current.status.state === 'stopped') return
      this.setStatus(def.name, {
        state: 'crashed',
        lastExitCode: code,
        startedAt: Date.now(),
      })
    })

    if (def.healthCheckUrl) {
      const timeoutMs = def.healthCheckTimeoutMs ?? HEALTH_TIMEOUT_MS_DEFAULT
      const healthy = await waitForHealthy(def.healthCheckUrl, child, logStream, def.name, timeoutMs)
      if (!healthy) {
        const reason = `health check did not pass within ${timeoutMs}ms (${def.healthCheckUrl})`
        logStream.write(`\n[service-manager] ${def.name}: ${reason}\n`)
        try {
          child.kill('SIGTERM')
        } catch {
          // Already exited — exit handler already updated status.
        }
        this.setStatus(def.name, { state: 'failed', reason, startedAt: Date.now() })
        return
      }
    }

    this.setStatus(def.name, {
      state: 'running',
      port: def.port,
      startedAt: Date.now(),
    })
  }

  stop(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state) return
    state.status = { state: 'stopped' }
    state.child?.kill('SIGTERM')
    this.emit('change', name, state.status)
  }

  stopAll(): void {
    for (const name of this.services.keys()) {
      this.stop(name)
    }
  }

  // Queues a stop+rebuild of an existing service so callers issuing
  // back-to-back restarts (e.g. user pasting Gemini then OpenAI keys)
  // never spawn two children at once. Each restart waits for the
  // previous one to either re-spawn the service or surface an error.
  restart(
    name: ServiceName,
    rebuildEnv?: () => NodeJS.ProcessEnv,
  ): Promise<void> {
    const next = this.restartChain.then(async () => {
      const state = this.services.get(name)
      if (!state) return
      const def = state.definition
      const child = state.child
      this.stop(name)
      await waitForChildExit(child)
      const replayDef: ServiceDefinition = rebuildEnv
        ? { ...def, env: rebuildEnv() }
        : def
      await this.start(replayDef)
    })
    this.restartChain = next.catch(() => undefined)
    return next
  }

  getStatus(name: ServiceName): ServiceStatus {
    return this.services.get(name)?.status ?? { state: 'idle' }
  }

  getAllStatuses(): Record<ServiceName, ServiceStatus> {
    const result: Record<string, ServiceStatus> = {}
    for (const [name, state] of this.services.entries()) {
      result[name] = state.status
    }
    return result as Record<ServiceName, ServiceStatus>
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private setStatus(name: ServiceName, status: ServiceStatus): void {
    const state = this.services.get(name)
    if (!state) return
    state.status = status
    this.emit('change', name, status)
  }
}

export const serviceManager = new ServiceManager()

async function waitForHealthy(
  url: string,
  child: ChildProcess,
  logStream: WriteStream,
  name: ServiceName,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      logStream.write(
        `\n[service-manager] ${name} exited (code=${child.exitCode}) before becoming healthy\n`,
      )
      return false
    }
    if (await probeHealth(url)) return true
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }
  return false
}

function probeHealth(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method: 'GET', timeout: 1_000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForChildExit(child: ChildProcess | null): Promise<void> {
  if (!child) return Promise.resolve()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => resolve()
    child.once('exit', done)
    child.once('error', done)
  })
}
