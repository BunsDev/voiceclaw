#!/usr/bin/env node
// Stand-in for the desktop's device-token bridge. Used by the pairing-401
// repro: starts a tiny HTTP server on a free loopback port, writes a
// device-token-bridge.json discovery file the relay can read, and only
// validates the one device-token plaintext passed via --known-token.
//
// Same surface as desktop/src/main/services/device-token-bridge.ts:
//   POST /device-token/check    { token } -> { ok, deviceId? }
//   POST /device-token/identify { token, name } -> { ok }
//   POST /device-token/touch    { id } -> { ok }
// Every request must carry the x-voiceclaw-nonce header.

import { createServer } from "node:http"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

function parseArgs(argv) {
  const out = { discoveryFile: "", knownToken: "", deviceId: "phone-test", port: 0 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--discovery-file") out.discoveryFile = argv[++i]
    else if (a === "--known-token") out.knownToken = argv[++i]
    else if (a === "--device-id") out.deviceId = argv[++i]
    else if (a === "--port") out.port = parseInt(argv[++i], 10) || 0
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.discoveryFile) {
    console.error("usage: repro-bridge-server.mjs --discovery-file PATH --known-token TOKEN [--device-id ID] [--port N]")
    process.exit(2)
  }
  const nonce = randomBytes(16).toString("hex")
  const server = createServer((req, res) => {
    const provided = req.headers["x-voiceclaw-nonce"]
    if (typeof provided !== "string" || provided !== nonce) {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "forbidden" }))
      return
    }
    let body = ""
    req.on("data", (c) => { body += c.toString("utf-8") })
    req.on("end", () => {
      let parsed = {}
      try { parsed = body.length ? JSON.parse(body) : {} } catch { parsed = {} }
      if (req.method === "POST" && req.url === "/device-token/check") {
        if (parsed.token === args.knownToken && args.knownToken.length > 0) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, deviceId: args.deviceId }))
        } else {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false }))
        }
        return
      }
      if (req.method === "POST" && req.url === "/device-token/identify") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === "POST" && req.url === "/device-token/touch") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(args.port, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : args.port
  const url = `http://127.0.0.1:${port}`
  mkdirSync(dirname(args.discoveryFile), { recursive: true })
  writeFileSync(args.discoveryFile, JSON.stringify({ url, nonce, pid: process.pid, startedAt: Date.now() }))
  console.log(JSON.stringify({ status: "ready", url, nonce, discoveryFile: args.discoveryFile }))

  const cleanup = () => {
    try { rmSync(args.discoveryFile, { force: true }) } catch { /* ignore */ }
    server.close(() => process.exit(0))
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
}

main().catch((err) => {
  console.error("bridge fatal:", err?.message ?? err)
  process.exit(1)
})
