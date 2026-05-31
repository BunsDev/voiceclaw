#!/usr/bin/env node
// Repro probe for the mobile-pairing 401.
//
// Connects to a WS URL, sends session.auth, waits for the first relay
// message OR close, then prints a single JSON line summarizing what
// actually happened on the wire. Intended to be run against a running
// relay (default ws://127.0.0.1:8080/ws). No mocks, no stubs.

import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, "..")
const require = createRequire(resolve(repoRoot, "package.json"))
const WebSocket = require("ws")

function parseArgs(argv) {
  const args = { url: "ws://127.0.0.1:8080/ws", key: "", scenario: "unnamed", timeoutMs: 7000 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--url") args.url = argv[++i]
    else if (a === "--key") args.key = argv[++i]
    else if (a === "--scenario") args.scenario = argv[++i]
    else if (a === "--timeout-ms") args.timeoutMs = parseInt(argv[++i], 10) || 7000
  }
  return args
}

function short(s) {
  if (typeof s !== "string" || s.length === 0) return ""
  if (s.length <= 12) return s
  return `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})`
}

function classifyKey(key) {
  if (typeof key !== "string" || key.length === 0) return "empty"
  if (key.startsWith("vcd_")) return "device-token-plaintext"
  // uuid v4 shape
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return "master-key-uuid"
  return "other"
}

async function run() {
  const args = parseArgs(process.argv)
  const result = {
    scenario: args.scenario,
    ws_url: args.url,
    api_key_kind: classifyKey(args.key),
    api_key_short: short(args.key),
    first_relay_message: null,
    close_code: null,
    close_reason: null,
    observed_result: "pending",
    error: null,
    timing_ms: {},
  }

  const t0 = Date.now()
  let ws
  try {
    ws = new WebSocket(args.url)
  } catch (err) {
    result.observed_result = "unreachable"
    result.error = err?.message ?? String(err)
    console.log(JSON.stringify(result))
    return
  }

  let firstMsgReceived = false
  let settled = false

  const settle = (label) => {
    if (settled) return
    settled = true
    result.observed_result = label
    result.timing_ms.total = Date.now() - t0
    try { ws.terminate() } catch { /* ignore */ }
    console.log(JSON.stringify(result))
  }

  const overallTimer = setTimeout(() => {
    if (!firstMsgReceived && result.close_code === null) {
      settle("timeout")
    }
  }, args.timeoutMs)
  overallTimer.unref?.()

  ws.on("open", () => {
    result.timing_ms.openMs = Date.now() - t0
    const payload = { type: "session.auth", apiKey: args.key, deviceName: "repro" }
    try {
      ws.send(JSON.stringify(payload))
    } catch (err) {
      result.error = `send failed: ${err?.message ?? err}`
      settle("other")
    }
  })

  ws.on("message", (raw) => {
    if (firstMsgReceived) return
    firstMsgReceived = true
    result.timing_ms.firstMsgMs = Date.now() - t0
    let parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      result.first_relay_message = String(raw).slice(0, 256)
      settle("malformed-server-msg")
      return
    }
    result.first_relay_message = parsed
    if (parsed?.type === "session.auth.ok") {
      settle("ok")
    } else if (parsed?.type === "error" && parsed.code === 401) {
      // Wait briefly to also capture the close code, but cap it.
      setTimeout(() => settle("401"), 250)
    } else {
      setTimeout(() => settle("other"), 250)
    }
  })

  ws.on("close", (code, reasonBuf) => {
    result.close_code = code
    result.close_reason = reasonBuf ? Buffer.from(reasonBuf).toString("utf8") : ""
    if (!firstMsgReceived) {
      // If we never got a message but got a close, that's still informative.
      // Classify by close code: 1006 abnormal = unreachable, 1008 policy violation = 401.
      if (code === 1006) settle("unreachable")
      else if (code === 1008) settle("401")
      else settle("other")
    } else if (!settled) {
      // first message arrived and close followed quickly; the message handler
      // already scheduled settle()
    }
  })

  ws.on("error", (err) => {
    if (settled) return
    result.error = err?.message ?? String(err)
    // socket errors before connection establish typically come through close too
    if (!firstMsgReceived && result.close_code === null) {
      // wait for close to fire
    }
  })
}

run().catch((err) => {
  console.log(JSON.stringify({
    scenario: "fatal",
    observed_result: "other",
    error: err?.message ?? String(err),
  }))
})
