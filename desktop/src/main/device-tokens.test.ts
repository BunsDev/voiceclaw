import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

// Fake DB router. Keys are exact SQL strings the device-tokens module
// prepares; values are statement-shaped objects that operate on an
// in-memory rows Map. Keeping the fake routing-by-SQL (rather than a
// generic parser) keeps the test honest: the production SQL has to
// land verbatim.

type Row = {
  id: string
  label: string
  token_hash: string
  created_at: number
  last_used_at: number | null
  revoked: number
}

let rows: Map<string, Row>

function pick<T extends Partial<Row>>(row: Row, keys: (keyof Row)[], aliases: Partial<Record<keyof Row, keyof T>> = {}): T {
  const out: Partial<Row> = {}
  for (const k of keys) {
    const alias = (aliases[k] as keyof Row | undefined) ?? k
    ;(out as Record<string, unknown>)[alias as string] = row[k]
  }
  return out as T
}

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
          for (const existing of rows.values()) {
            if (existing.token_hash === hash) {
              throw new Error('UNIQUE constraint failed: device_tokens.token_hash')
            }
          }
          rows.set(id, {
            id,
            label,
            token_hash: hash,
            created_at: createdAt,
            last_used_at: null,
            revoked: 0,
          })
        },
      }
    }
    if (
      sql ===
      `SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, revoked
       FROM device_tokens
       ORDER BY created_at DESC`
    ) {
      return {
        all: () =>
          [...rows.values()]
            .sort((a, b) => b.created_at - a.created_at)
            .map((r) => ({
              id: r.id,
              label: r.label,
              createdAt: r.created_at,
              lastUsedAt: r.last_used_at,
              revoked: r.revoked,
            })),
      }
    }
    if (sql === 'UPDATE device_tokens SET revoked = 1 WHERE id = ?') {
      return {
        run: (id: string) => {
          const row = rows.get(id)
          if (row) row.revoked = 1
        },
      }
    }
    if (sql === 'UPDATE device_tokens SET label = ? WHERE id = ?') {
      return {
        run: (label: string, id: string) => {
          const row = rows.get(id)
          if (row) row.label = label
        },
      }
    }
    if (sql === 'DELETE FROM device_tokens WHERE id = ?') {
      return { run: (id: string) => { rows.delete(id) } }
    }
    if (sql === 'SELECT id, revoked FROM device_tokens WHERE token_hash = ?') {
      return {
        get: (hash: string) => {
          for (const row of rows.values()) {
            if (row.token_hash === hash) return { id: row.id, revoked: row.revoked }
          }
          return undefined
        },
      }
    }
    if (sql === 'UPDATE device_tokens SET last_used_at = ? WHERE id = ?') {
      return {
        run: (ts: number, id: string) => {
          const row = rows.get(id)
          if (row) row.last_used_at = ts
        },
      }
    }
    throw new Error(`unexpected SQL in test: ${sql}`)
  },
  // Test-only helpers — production code never touches these.
  _rows: () => rows,
}

vi.mock('./db', () => ({
  getDb: () => fakeDb,
}))

vi.mock('./onboarding', () => ({
  ensureOnboardingSchema: () => undefined,
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/voiceclaw-device-tokens-test',
  },
}))

describe('device tokens', () => {
  beforeEach(() => {
    rows = new Map()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('mints a high-entropy token with the vcd_ prefix and stores only the sha256 hash', async () => {
    const { createDeviceToken, hashDeviceToken } = await import('./device-tokens')
    const created = createDeviceToken('iPhone 15')
    expect(created.plaintext.startsWith('vcd_')).toBe(true)
    // randomBytes(32) → 43 chars unpadded base64url plus the 4-char prefix.
    expect(created.plaintext.length).toBeGreaterThanOrEqual(45)
    expect(created.label).toBe('iPhone 15')

    const stored = rows.get(created.id)!
    expect(stored.token_hash).toBe(hashDeviceToken(created.plaintext))
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.token_hash).not.toBe(created.plaintext)
    expect(stored.label).toBe('iPhone 15')
    expect(stored.revoked).toBe(0)
  })

  it('produces a different token each call', async () => {
    const { createDeviceToken } = await import('./device-tokens')
    const a = createDeviceToken('a')
    const b = createDeviceToken('b')
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.id).not.toBe(b.id)
  })

  it('hashDeviceToken is stable for the same input', async () => {
    const { hashDeviceToken } = await import('./device-tokens')
    const h1 = hashDeviceToken('vcd_example')
    const h2 = hashDeviceToken('vcd_example')
    expect(h1).toBe(h2)
    expect(h1).toBe(createHash('sha256').update('vcd_example', 'utf8').digest('hex'))
  })

  it('rejects a blank label', async () => {
    const { createDeviceToken } = await import('./device-tokens')
    expect(() => createDeviceToken('   ')).toThrow(/label/)
  })

  it('listDeviceTokens returns rows without plaintext or hash, newest first', async () => {
    const { createDeviceToken, listDeviceTokens } = await import('./device-tokens')
    const a = createDeviceToken('first')
    rows.get(a.id)!.created_at = 1
    const b = createDeviceToken('second')
    rows.get(b.id)!.created_at = 2

    const listed = listDeviceTokens()
    expect(listed.map((r) => r.label)).toEqual(['second', 'first'])
    for (const row of listed) {
      expect(row).not.toHaveProperty('plaintext')
      expect(row).not.toHaveProperty('tokenHash')
      expect(row).not.toHaveProperty('token_hash')
    }
  })

  it('revokeDeviceToken flips the revoked flag and survives lookup', async () => {
    const { createDeviceToken, revokeDeviceToken, lookupDeviceTokenByHash, hashDeviceToken } =
      await import('./device-tokens')
    const t = createDeviceToken('phone')
    revokeDeviceToken(t.id)
    const looked = lookupDeviceTokenByHash(hashDeviceToken(t.plaintext))
    expect(looked).toEqual({ id: t.id, revoked: true })
    // Idempotent.
    revokeDeviceToken(t.id)
    expect(lookupDeviceTokenByHash(hashDeviceToken(t.plaintext))?.revoked).toBe(true)
  })

  it('renameDeviceToken updates the label without rotating the hash', async () => {
    const { createDeviceToken, renameDeviceToken } = await import('./device-tokens')
    const t = createDeviceToken('original')
    const beforeHash = rows.get(t.id)!.token_hash
    renameDeviceToken(t.id, 'renamed')
    const after = rows.get(t.id)!
    expect(after.label).toBe('renamed')
    expect(after.token_hash).toBe(beforeHash)
  })

  it('removeDeviceToken deletes the row entirely', async () => {
    const { createDeviceToken, removeDeviceToken, lookupDeviceTokenByHash, hashDeviceToken } =
      await import('./device-tokens')
    const t = createDeviceToken('to-delete')
    removeDeviceToken(t.id)
    expect(lookupDeviceTokenByHash(hashDeviceToken(t.plaintext))).toBeNull()
  })

  it('lookupDeviceTokenByHash returns null for an unknown hash', async () => {
    const { lookupDeviceTokenByHash } = await import('./device-tokens')
    expect(lookupDeviceTokenByHash('0'.repeat(64))).toBeNull()
  })

  it('touchDeviceToken bumps last_used_at', async () => {
    const { createDeviceToken, touchDeviceToken } = await import('./device-tokens')
    const t = createDeviceToken('used')
    expect(rows.get(t.id)!.last_used_at).toBeNull()
    touchDeviceToken(t.id)
    const stamp = rows.get(t.id)!.last_used_at
    expect(typeof stamp).toBe('number')
    expect(stamp).toBeGreaterThan(0)
  })
})
