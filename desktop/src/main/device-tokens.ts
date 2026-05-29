import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getDb } from './db'
import { ensureOnboardingSchema } from './onboarding'

// Per-device pairing tokens. Each paired mobile device gets its own
// 256-bit token, surfaced as plaintext ONCE at creation time (inside
// the QR payload) and stored ONLY as a sha256 hex digest. Tokens can
// be revoked individually so losing a phone can't lock the rest of
// the household out.

const TOKEN_PREFIX = 'vcd_'

export type DeviceTokenRow = {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  revoked: boolean
}

export type CreatedDeviceToken = {
  id: string
  label: string
  plaintext: string
  createdAt: number
}

export function createDeviceToken(label: string): CreatedDeviceToken {
  ensureOnboardingSchema()
  const trimmed = label.trim()
  if (trimmed.length === 0) throw new Error('label is required')
  const id = randomUUID()
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const tokenHash = hashDeviceToken(plaintext)
  const createdAt = Date.now()
  const db = getDb()
  db.prepare(
    `INSERT INTO device_tokens (id, label, token_hash, created_at, last_used_at, revoked)
     VALUES (?, ?, ?, ?, NULL, 0)`,
  ).run(id, trimmed, tokenHash, createdAt)
  return { id, label: trimmed, plaintext, createdAt }
}

export function listDeviceTokens(): DeviceTokenRow[] {
  ensureOnboardingSchema()
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, revoked
       FROM device_tokens
       ORDER BY created_at DESC`,
    )
    .all() as { id: string; label: string; createdAt: number; lastUsedAt: number | null; revoked: number }[]
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revoked: r.revoked !== 0,
  }))
}

export function revokeDeviceToken(id: string): void {
  ensureOnboardingSchema()
  const db = getDb()
  db.prepare('UPDATE device_tokens SET revoked = 1 WHERE id = ?').run(id)
}

export function renameDeviceToken(id: string, label: string): void {
  ensureOnboardingSchema()
  const trimmed = label.trim()
  if (trimmed.length === 0) throw new Error('label is required')
  const db = getDb()
  db.prepare('UPDATE device_tokens SET label = ? WHERE id = ?').run(trimmed, id)
}

export function removeDeviceToken(id: string): void {
  ensureOnboardingSchema()
  const db = getDb()
  db.prepare('DELETE FROM device_tokens WHERE id = ?').run(id)
}

// Read-side helpers used by the localhost device-token bridge that the
// relay calls to validate inbound credentials. The bridge does not see
// plaintext — the relay hashes locally and asks "is this hash valid?".
export function lookupDeviceTokenByHash(
  tokenHash: string,
): { id: string; revoked: boolean } | null {
  ensureOnboardingSchema()
  const db = getDb()
  const row = db
    .prepare('SELECT id, revoked FROM device_tokens WHERE token_hash = ?')
    .get(tokenHash) as { id: string; revoked: number } | undefined
  if (!row) return null
  return { id: row.id, revoked: row.revoked !== 0 }
}

export function touchDeviceToken(id: string): void {
  ensureOnboardingSchema()
  const db = getDb()
  db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
}

export function hashDeviceToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}
