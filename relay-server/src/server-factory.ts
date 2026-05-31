import { readFileSync } from "node:fs"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { RequestListener } from "node:http"

export type ServerFactoryEnv = {
  RELAY_TLS_CERT?: string
  RELAY_TLS_KEY?: string
}

export type CreatedRelayServer = {
  server: HttpServer
  tls: boolean
}

// Creates the HTTP(S) listener that the WebSocket server attaches to.
// When RELAY_TLS_CERT and RELAY_TLS_KEY are present, returns an https
// server so the relay speaks wss://. Otherwise returns a plain http
// server (today's behavior — preserves `yarn dev` with no cert).
export function createRelayServer(
  app: RequestListener,
  env: ServerFactoryEnv = process.env,
): CreatedRelayServer {
  const certPath = env.RELAY_TLS_CERT?.trim()
  const keyPath = env.RELAY_TLS_KEY?.trim()
  if (certPath && keyPath) {
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)
    // https.Server extends http.Server at the type level for our purposes.
    return { server: createHttpsServer({ cert, key }, app) as unknown as HttpServer, tls: true }
  }
  return { server: createHttpServer(app), tls: false }
}
