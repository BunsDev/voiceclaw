import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isPackagedRef = { value: false }
const existsRef = { fn: (_p: string) => false as boolean }
let originalResourcesPath: string | undefined

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return isPackagedRef.value
    },
    getPath: () => '/tmp/voiceclaw-test',
  },
}))

vi.mock('fs', () => ({
  existsSync: (path: string) => existsRef.fn(path),
  copyFileSync: () => undefined,
  mkdirSync: () => undefined,
  readFileSync: () => '{}',
}))

describe('resolveBundledOpenClawScript', () => {
  beforeEach(() => {
    originalResourcesPath = process.resourcesPath
    isPackagedRef.value = false
    existsRef.fn = () => false
  })

  afterEach(() => {
    if (originalResourcesPath !== undefined) {
      Object.defineProperty(process, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true,
      })
    }
    vi.resetModules()
  })

  it('returns packaged path when app.isPackaged and script exists', async () => {
    isPackagedRef.value = true
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/VoiceClaw.app/Contents/Resources',
      configurable: true,
    })
    existsRef.fn = (p: string) =>
      p === '/Applications/VoiceClaw.app/Contents/Resources/openclaw/openclaw.mjs'

    const { resolveBundledOpenClawScript } = await import('./openclaw-gateway')
    expect(resolveBundledOpenClawScript()).toBe(
      '/Applications/VoiceClaw.app/Contents/Resources/openclaw/openclaw.mjs',
    )
  })

  it('returns null in packaged mode when script is missing', async () => {
    isPackagedRef.value = true
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/VoiceClaw.app/Contents/Resources',
      configurable: true,
    })
    existsRef.fn = () => false

    const { resolveBundledOpenClawScript } = await import('./openclaw-gateway')
    expect(resolveBundledOpenClawScript()).toBeNull()
  })

  it('returns dev path under vendor/openclaw/ when not packaged', async () => {
    isPackagedRef.value = false
    existsRef.fn = (p: string) => p.endsWith('/vendor/openclaw/openclaw.mjs')

    const { resolveBundledOpenClawScript } = await import('./openclaw-gateway')
    const resolved = resolveBundledOpenClawScript()
    expect(resolved).not.toBeNull()
    expect(resolved!.endsWith('/vendor/openclaw/openclaw.mjs')).toBe(true)
  })
})
