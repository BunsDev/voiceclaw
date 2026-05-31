import "dotenv/config"
import { initLangfuse, shutdownLangfuse } from "./tracing/langfuse.js"
// initLangfuse must run BEFORE any module that may create OTEL spans on import,
// since the NodeSDK replaces the global TracerProvider.
initLangfuse()

import express from "express"
import { networkInterfaces } from "node:os"
import { WebSocketServer } from "ws"
import { RelaySession } from "./session.js"
import { getTestPageHTML } from "./test-page.js"
import { log, warn, error as logError } from "./log.js"
import { gracefulShutdown } from "./shutdown.js"
import { createRelayServer } from "./server-factory.js"
import { getBridgeConfig, getDiscoveryFilePath } from "./device-tokens.js"

const SHUTDOWN_TIMEOUT_MS = 10_000

const PORT = parseInt(process.env.PORT ?? "8080", 10)
// Default to loopback so a misconfigured relay (no RELAY_API_KEY, no firewall)
// is not reachable from the LAN/tailnet. The desktop sets RELAY_BIND_HOST
// explicitly to 0.0.0.0 when the user opted into mobile pairing.
const HOST = process.env.RELAY_BIND_HOST?.trim() || "127.0.0.1"

const app = express()

app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

app.get("/test", (req, res) => {
  if (!isTestPageEnabled()) {
    res.status(404).json({ error: "Test page disabled in production" })
    return
  }

  const host = req.headers.host ?? `localhost:${PORT}`
  res.type("html").send(getTestPageHTML(host))
})

const { server, tls: tlsActive } = createRelayServer(app)

// 4 MB headroom for screen-share frames — composite + original + strokes-png in
// a single frame.append message can comfortably exceed the previous 1 MB cap.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1_048_576 })

wss.on("connection", (ws) => {
  new RelaySession(ws)
})

// Guards SIGTERM/SIGINT idempotency at the OS-signal layer; the drain-loop
// flag in shutdown.ts guards gracefulShutdown itself.
let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log("Shutting down...")

  // If server.close() hangs on a stuck keep-alive socket, the awaits below
  // never complete and gracefulShutdown is never reached. Backstop with a
  // hard-kill timer so the process always exits.
  const hardKill = setTimeout(() => {
    warn("[shutdown] hard-kill timeout reached, forcing exit")
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS + 5_000)
  hardKill.unref()

  // Close client sockets first so each RelaySession runs its cleanup()
  // (endSession → adapter disconnect → transcript sync) before we tear
  // down the OTel exporter that ships the final spans.
  wss.clients.forEach((ws) => ws.close())
  wss.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))

  // Order: gracefulShutdown drains background tasks (which finish their bg.end()
  // calls) BEFORE shutdownLangfuse flushes the SDK — otherwise span ends race
  // the export pipeline and the last few ops disappear.
  await gracefulShutdown(SHUTDOWN_TIMEOUT_MS)

  // Drain pending spans before exiting — otherwise the last turn of every
  // active session gets dropped on SIGTERM.
  await shutdownLangfuse()
  process.exit(0)
}

process.on("SIGTERM", () => { void shutdown() })
process.on("SIGINT", () => { void shutdown() })

if (!process.env.RELAY_API_KEY) {
  // Production must have a relay key or the WS is wide open: any LAN/tailnet
  // peer can run mint_token / tool.exec / session.prep. The dev override is
  // explicit so we never ship "we just forgot to set it".
  if (process.env.NODE_ENV === "production" && process.env.RELAY_ALLOW_UNAUTHENTICATED !== "true") {
    logError("RELAY_API_KEY is not set in production — refusing to start (set RELAY_ALLOW_UNAUTHENTICATED=true to bypass for local dev only)")
    process.exit(1)
  }
  warn("⚠️  RELAY_API_KEY is not set — WebSocket connections will not require authentication (dev only)")
}

const httpScheme = tlsActive ? "https" : "http"
const wsScheme = tlsActive ? "wss" : "ws"
server.listen(PORT, HOST, () => {
  const lanIP = getLanIP()
  log(`Relay server listening on ${httpScheme}://${HOST}:${PORT}`)
  if (isTestPageEnabled()) {
    log(`Test page: ${httpScheme}://localhost:${PORT}/test`)
  }
  if (HOST === "0.0.0.0" && lanIP) {
    log(`Connect from your phone:`)
    log(`  ${wsScheme}://${lanIP}:${PORT}/ws`)
    if (isTestPageEnabled()) {
      log(`  Test page: ${httpScheme}://${lanIP}:${PORT}/test`)
    }
  }
  const bridge = getBridgeConfig()
  if (bridge) {
    log(`Device-token bridge: ${bridge.url} (source=${bridge.source})`)
  } else {
    const discoveryPath = getDiscoveryFilePath()
    warn(
      `Device-token bridge: NOT CONFIGURED — paired mobile clients (vcd_ tokens) will be rejected with 401. ` +
      `Start the desktop app so it writes the discovery file at ${discoveryPath ?? "<unknown>"}, ` +
      `or export VOICECLAW_DEVICE_TOKEN_CHECK_URL + VOICECLAW_DEVICE_TOKEN_CHECK_NONCE before starting the relay.`,
    )
  }
})

function isTestPageEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_TEST_PAGE === "true"
  )
}

function getLanIP(): string | null {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address
      }
    }
  }
  return null
}
