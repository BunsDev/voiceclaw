import { describe, expect, it, afterEach, beforeAll } from "vitest"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import express from "express"
import { createRelayServer } from "./server-factory.js"

let CERT_PEM = ""
let KEY_PEM = ""

beforeAll(() => {
  // Real self-signed cert/key — the TLS branch calls
  // tls.createSecureContext which rejects malformed PEM eagerly. openssl
  // is universally present on macOS/Linux CI images.
  if (!CERT_PEM) {
    const dir = mkdtempSync(join(tmpdir(), "relay-tls-genkey-"))
    const certPath = join(dir, "cert.pem")
    const keyPath = join(dir, "key.pem")
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -keyout ${keyPath} -out ${certPath}`,
      { stdio: "ignore" },
    )
    CERT_PEM = require("node:fs").readFileSync(certPath, "utf-8")
    KEY_PEM = require("node:fs").readFileSync(keyPath, "utf-8")
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("createRelayServer", () => {
  let tmpDir: string | null = null

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it("returns a plain http server when no TLS env is set", () => {
    const app = express()
    const { server, tls } = createRelayServer(app, {})
    expect(tls).toBe(false)
    // node:http Server lacks a `cert` property; node:https Server has one.
    expect((server as unknown as { cert?: unknown }).cert).toBeUndefined()
    server.close()
  })

  it("returns an https server when RELAY_TLS_CERT and RELAY_TLS_KEY are set", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "relay-tls-test-"))
    const certPath = join(tmpDir, "cert.pem")
    const keyPath = join(tmpDir, "key.pem")
    writeFileSync(certPath, CERT_PEM)
    writeFileSync(keyPath, KEY_PEM)
    const app = express()
    const { server, tls } = createRelayServer(app, {
      RELAY_TLS_CERT: certPath,
      RELAY_TLS_KEY: keyPath,
    })
    expect(tls).toBe(true)
    expect(server.constructor.name).toBe("Server") // https.Server
    server.close()
  })

  it("falls back to http when only one of cert/key is set", () => {
    const app = express()
    const { tls } = createRelayServer(app, { RELAY_TLS_CERT: "/nope.pem" })
    expect(tls).toBe(false)
  })
})
