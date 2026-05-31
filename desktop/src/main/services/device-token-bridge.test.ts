import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory device_tokens table — same routing-by-SQL approach as
// device-tokens.test.ts so the bridge sees the real production
// implementations of hashing, lookup, and the default-label guard.

type Row = {
  id: string
  label: string
  token_hash: string
  created_at: number
  last_used_at: number | null
  revoked: number
}

let rows: Map<string, Row>

const fakeDb = {
  exec: () => undefined,
  prepare: (sql: string) => {
    if (
      sql ===
      `INSERT INTO device_tokens (id, label, token_hash, created_at, last_used_at, revoked)
     VALUES (?, ?, ?, ?, NULL, 0)`
    ) {
      return {
        run: (id: string, label: string, hash: string, createdAt: number) => {
          rows.set(id, { id, label, token_hash: hash, created_at: createdAt, last_used_at: null, revoked: 0 })
        },
      }
    }
    if (sql === 'SELECT id, revoked FROM device_tokens WHERE token_hash = ?') {
      return {
        get: (hash: string) => {
          for (const r of rows.values()) {
            if (r.token_hash === hash) return { id: r.id, revoked: r.revoked }
          }
          return undefined
        },
      }
    }
    if (sql === 'SELECT id, label FROM device_tokens WHERE token_hash = ?') {
      return {
        get: (hash: string) => {
          for (const r of rows.values()) {
            if (r.token_hash === hash) return { id: r.id, label: r.label }
          }
          return undefined
        },
      }
    }
    if (sql === 'UPDATE device_tokens SET label = ? WHERE id = ?') {
      return {
        run: (label: string, id: string) => {
          const r = rows.get(id)
          if (r) r.label = label
        },
      }
    }
    if (sql === 'UPDATE device_tokens SET last_used_at = ? WHERE id = ?') {
      return { run: () => undefined }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  },
}

vi.mock('../db', () => ({ getDb: () => fakeDb }))
vi.mock('../onboarding', () => ({ ensureOnboardingSchema: () => undefined }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/voiceclaw-bridge-test' } }))

describe('device-token-bridge /device-token/identify', () => {
  beforeEach(() => {
    rows = new Map()
  })

  afterEach(async () => {
    const { stopDeviceTokenBridge } = await import('./device-token-bridge')
    await stopDeviceTokenBridge()
    vi.resetModules()
  })

  it('renames a token whose label still matches the default pattern (nonce required)', async () => {
    const { createDeviceToken } = await import('../device-tokens')
    const t = createDeviceToken('New device · Mar 4')
    const { startDeviceTokenBridge } = await import('./device-token-bridge')
    const handle = await startDeviceTokenBridge()

    const noNonce = await fetch(`${handle.url}/device-token/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: t.plaintext, name: "Michael's iPhone" }),
    })
    expect(noNonce.status).toBe(403)
    expect(rows.get(t.id)!.label).toBe('New device · Mar 4')

    const ok = await fetch(`${handle.url}/device-token/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voiceclaw-nonce': handle.nonce },
      body: JSON.stringify({ token: t.plaintext, name: "Michael's iPhone" }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, renamed: true })
    expect(rows.get(t.id)!.label).toBe("Michael's iPhone")
  })

  it('leaves a user-renamed label untouched', async () => {
    const { createDeviceToken, renameDeviceToken } = await import('../device-tokens')
    const t = createDeviceToken('New device · Mar 4')
    renameDeviceToken(t.id, 'My Phone')
    const { startDeviceTokenBridge } = await import('./device-token-bridge')
    const handle = await startDeviceTokenBridge()

    const res = await fetch(`${handle.url}/device-token/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voiceclaw-nonce': handle.nonce },
      body: JSON.stringify({ token: t.plaintext, name: 'Auto' }),
    })
    expect(await res.json()).toEqual({ ok: true, renamed: false })
    expect(rows.get(t.id)!.label).toBe('My Phone')
  })

  it('returns ok:false on bad input', async () => {
    const { startDeviceTokenBridge } = await import('./device-token-bridge')
    const handle = await startDeviceTokenBridge()
    const res = await fetch(`${handle.url}/device-token/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voiceclaw-nonce': handle.nonce },
      body: JSON.stringify({ token: '', name: '' }),
    })
    expect(await res.json()).toEqual({ ok: false })
  })
})
