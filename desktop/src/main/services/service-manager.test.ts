import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

vi.mock('../logs', () => ({
  openLogStream: () => ({ write: () => undefined, end: () => undefined }),
}))

class FakeChild {
  exitCode: number | null = null
  signalCode: string | null = null
  stdout = { pipe: () => undefined }
  stderr = { pipe: () => undefined }
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  killed = false
  killCount = 0

  on(_event: string, _cb: (...args: unknown[]) => void): this {
    return this
  }

  once(event: string, cb: (...args: unknown[]) => void): this {
    const arr = this.listeners.get(event) ?? []
    arr.push(cb)
    this.listeners.set(event, arr)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    const arr = this.listeners.get(event) ?? []
    for (const cb of arr) cb(...args)
  }

  kill(_signal?: string): boolean {
    this.killed = true
    this.killCount += 1
    setImmediate(() => {
      this.exitCode = 0
      this.emit('exit', 0)
    })
    return true
  }
}

describe('ServiceManager.restart', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops the existing child, awaits its exit, and rebuilds env', async () => {
    const children: FakeChild[] = []
    spawnMock.mockImplementation(() => {
      const c = new FakeChild()
      children.push(c)
      return c
    })

    const { serviceManager } = await import('./service-manager')

    const def = {
      name: 'relay' as const,
      command: '/usr/bin/node',
      args: ['relay.js'],
      env: { GEMINI_API_KEY: 'first' } as NodeJS.ProcessEnv,
      port: 12345,
      logFile: 'relay.log',
    }
    await serviceManager.start(def)
    expect(children.length).toBe(1)
    expect(spawnMock.mock.calls[0][2].env.GEMINI_API_KEY).toBe('first')

    let envCall = 0
    const restartPromise = serviceManager.restart('relay', () => {
      envCall += 1
      return { GEMINI_API_KEY: 'second' }
    })
    await restartPromise

    expect(envCall).toBe(1)
    expect(children.length).toBe(2)
    expect(children[0].killed).toBe(true)
    expect(spawnMock.mock.calls[1][2].env.GEMINI_API_KEY).toBe('second')
  })

  it('serializes back-to-back restarts so spawns never overlap', async () => {
    const children: FakeChild[] = []
    spawnMock.mockImplementation(() => {
      const c = new FakeChild()
      children.push(c)
      return c
    })

    const { serviceManager } = await import('./service-manager')

    const def = {
      name: 'relay' as const,
      command: '/usr/bin/node',
      args: ['relay.js'],
      env: {} as NodeJS.ProcessEnv,
      port: 12346,
      logFile: 'relay.log',
    }
    await serviceManager.start(def)

    const order: string[] = []
    const a = serviceManager.restart('relay', () => {
      order.push('a-build')
      return { TAG: 'a' }
    })
    const b = serviceManager.restart('relay', () => {
      order.push('b-build')
      return { TAG: 'b' }
    })
    await Promise.all([a, b])

    expect(order).toEqual(['a-build', 'b-build'])
    expect(spawnMock.mock.calls.at(-1)?.[2].env.TAG).toBe('b')
  })
})
