import { describe, expect, it, vi } from 'vitest'
import { buildPairDeeplink, mintAndMaybeRevoke } from './pair'

describe('buildPairDeeplink', () => {
  it('builds a voiceclaw-staging://pair URL with encoded query params', () => {
    const link = buildPairDeeplink('voiceclaw-staging', {
      url: 'wss://macbook.tailabcd.ts.net:8080/ws',
      token: 'tok_abc/123+xyz',
      label: 'iPhone 15 Pro',
    })
    expect(link.startsWith('voiceclaw-staging://pair?')).toBe(true)
    const parsed = new URL(link.replace('voiceclaw-staging://', 'https://placeholder/'))
    expect(parsed.searchParams.get('url')).toBe('wss://macbook.tailabcd.ts.net:8080/ws')
    expect(parsed.searchParams.get('token')).toBe('tok_abc/123+xyz')
    expect(parsed.searchParams.get('label')).toBe('iPhone 15 Pro')
    expect(parsed.searchParams.get('v')).toBe('1')
  })

  it('respects per-variant schemes', () => {
    expect(buildPairDeeplink('voiceclaw-dev', { url: 'ws://x/y', token: 't', label: 'L' })).toMatch(/^voiceclaw-dev:\/\/pair\?/)
    expect(buildPairDeeplink('voiceclaw', { url: 'ws://x/y', token: 't', label: 'L' })).toMatch(/^voiceclaw:\/\/pair\?/)
  })
})

describe('mintAndMaybeRevoke', () => {
  const make = () => {
    const created: string[] = []
    const revoked: string[] = []
    const api = {
      create: vi.fn(async (_label: string) => {
        const id = `dev-${created.length + 1}`
        created.push(id)
        return { ok: true as const, id }
      }),
      revoke: vi.fn(async (id: string) => {
        revoked.push(id)
        return { ok: true as const }
      }),
    }
    return { api, created, revoked }
  }

  it('returns the created row when still current', async () => {
    const { api, revoked } = make()
    const result = await mintAndMaybeRevoke(api, 'iPhone', () => true)
    expect(result).toEqual({ ok: true, id: 'dev-1' })
    expect(revoked).toEqual([])
  })

  it('auto-revokes the freshly minted token when the user cancelled mid-mint', async () => {
    const { api, revoked } = make()
    const result = await mintAndMaybeRevoke(api, 'iPhone', () => false)
    expect(result).toEqual({ ok: false, cancelled: true })
    expect(revoked).toEqual(['dev-1'])
  })

  it('does not call revoke when create itself failed', async () => {
    const api = {
      create: vi.fn(async () => ({ ok: false as const, error: 'db locked' })),
      revoke: vi.fn(),
    }
    const result = await mintAndMaybeRevoke(api, 'iPhone', () => false)
    expect(result).toEqual({ ok: false, error: 'db locked' })
    expect(api.revoke).not.toHaveBeenCalled()
  })
})
