import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { URL } from 'node:url'
import { app } from 'electron'
import {
  hashDeviceToken,
  lookupDeviceTokenByHash,
  renameDeviceTokenIfDefault,
  touchDeviceToken,
} from '../device-tokens'

// Localhost-only HTTP endpoint the bundled relay calls to validate
// inbound per-device tokens. The desktop owns the SQLite DB AND the
// token-hashing function; the relay (separate process, plain Node)
// shouldn't open the DB directly — adding better-sqlite3 to the relay's
// deps would mean a second native-ABI build of a module that the
// desktop already rebuilds for Electron. So we expose a tiny loopback
// bridge instead and let the relay forward the plaintext token; this
// process hashes it against the stored sha256 digests and answers
// "valid or not".
//
// Surface: bind 127.0.0.1 on an OS-picked port. A per-launch nonce is
// required on every request via the x-voiceclaw-nonce header so a
// hostile local process can't probe the endpoint just by guessing the
// port. URL + nonce are handed to the relay via env vars
// (VOICECLAW_DEVICE_TOKEN_CHECK_URL, VOICECLAW_DEVICE_TOKEN_CHECK_NONCE).

const NONCE_HEADER = 'x-voiceclaw-nonce'
const DISCOVERY_FILE_NAME = 'device-token-bridge.json'

export type DeviceTokenBridgeHandle = {
  url: string
  nonce: string
  close: () => Promise<void>
}

let active: DeviceTokenBridgeHandle | null = null

export function getDeviceTokenBridge(): DeviceTokenBridgeHandle | null {
  return active
}

export function getDeviceTokenBridgeDiscoveryPath(): string {
  return join(app.getPath('userData'), DISCOVERY_FILE_NAME)
}

export async function startDeviceTokenBridge(): Promise<DeviceTokenBridgeHandle> {
  if (active) return active
  const nonce = randomBytes(32).toString('hex')
  const server = createServer((req, res) => handleRequest(req, res, nonce))
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}`
  const discoveryPath = writeDiscoveryFile({ url, nonce })
  const handle: DeviceTokenBridgeHandle = {
    url,
    nonce,
    close: () =>
      new Promise<void>((resolve) => {
        removeDiscoveryFile(discoveryPath)
        server.close(() => resolve())
      }),
  }
  active = handle
  return handle
}

export async function stopDeviceTokenBridge(): Promise<void> {
  if (!active) return
  const handle = active
  active = null
  await handle.close()
}

function writeDiscoveryFile(payload: { url: string; nonce: string }): string | null {
  try {
    const path = getDeviceTokenBridgeDiscoveryPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ ...payload, pid: process.pid, startedAt: Date.now() }, null, 2),
      { mode: 0o600 },
    )
    return path
  } catch (err) {
    console.warn('[device-token-bridge] failed to write discovery file', err)
    return null
  }
}

function removeDiscoveryFile(path: string | null): void {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch (err) {
    console.warn('[device-token-bridge] failed to remove discovery file', err)
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        reject(new Error('device-token bridge: unexpected address shape'))
        return
      }
      resolve(address.port)
    })
  })
}

function handleRequest(req: IncomingMessage, res: ServerResponse, nonce: string): void {
  const provided = req.headers[NONCE_HEADER]
  if (typeof provided !== 'string' || provided !== nonce) {
    respond(res, 403, { error: 'forbidden' })
    return
  }
  if (!req.url) {
    respond(res, 400, { error: 'missing url' })
    return
  }
  const parsed = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'POST' && parsed.pathname === '/device-token/check') {
    readJson(req)
      .then((body) => {
        const token = typeof (body as { token?: unknown }).token === 'string'
          ? (body as { token: string }).token
          : ''
        if (token.length === 0) {
          respond(res, 200, { ok: false })
          return
        }
        const row = lookupDeviceTokenByHash(hashDeviceToken(token))
        if (!row || row.revoked) {
          respond(res, 200, { ok: false })
          return
        }
        respond(res, 200, { ok: true, deviceId: row.id })
      })
      .catch(() => respond(res, 200, { ok: false }))
    return
  }
  if (req.method === 'POST' && parsed.pathname === '/device-token/identify') {
    readJson(req)
      .then((body) => {
        const token = typeof (body as { token?: unknown }).token === 'string'
          ? (body as { token: string }).token
          : ''
        const name = typeof (body as { name?: unknown }).name === 'string'
          ? (body as { name: string }).name
          : ''
        if (token.length === 0 || name.trim().length === 0) {
          respond(res, 200, { ok: false })
          return
        }
        try {
          const renamed = renameDeviceTokenIfDefault(hashDeviceToken(token), name)
          respond(res, 200, { ok: true, renamed })
        } catch {
          respond(res, 200, { ok: false })
        }
      })
      .catch(() => respond(res, 200, { ok: false }))
    return
  }
  if (req.method === 'POST' && parsed.pathname === '/device-token/touch') {
    readJson(req)
      .then((body) => {
        const id = typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : ''
        if (id.length > 0) {
          try {
            touchDeviceToken(id)
          } catch {
            // Best-effort — never fail the auth path.
          }
        }
        respond(res, 200, { ok: true })
      })
      .catch(() => respond(res, 200, { ok: true }))
    return
  }
  respond(res, 404, { error: 'not found' })
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 4 * 1024) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolve(raw.length === 0 ? {} : JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}
