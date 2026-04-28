import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer, WebSocket as WsSocket } from "ws"
import { composeTurnInput, TurnTracer } from "../../src/tracing/turn-tracer.js"
import { GeminiAdapter } from "../../src/adapters/gemini.js"
import { OpenAIAdapter } from "../../src/adapters/openai.js"
import type { SessionConfigEvent } from "../../src/types.js"

describe("composeTurnInput", () => {
  it("returns system-only when no preamble, no history, no user text", () => {
    const out = composeTurnInput("BASE", null, [], "")
    expect(out).toEqual([{ role: "system", content: "BASE" }])
  })

  it("merges base + preamble into a single system message", () => {
    const out = composeTurnInput("BASE", "PREAMBLE", [], "hello")
    expect(out).toEqual([
      { role: "system", content: "BASE\n\nPREAMBLE" },
      { role: "user", content: "hello" },
    ])
  })

  it("interleaves recent verbatim turns between system and current user", () => {
    const history = [
      { role: "user" as const, text: "u1" },
      { role: "assistant" as const, text: "a1" },
      { role: "user" as const, text: "u2" },
    ]
    const out = composeTurnInput("BASE", null, history, "now")
    expect(out).toHaveLength(5)
    expect(out[0]).toEqual({ role: "system", content: "BASE" })
    expect(out[1]).toEqual({ role: "user", content: "u1" })
    expect(out[2]).toEqual({ role: "assistant", content: "a1" })
    expect(out[3]).toEqual({ role: "user", content: "u2" })
    expect(out[4]).toEqual({ role: "user", content: "now" })
  })

  it("returns user-only when no system content is supplied", () => {
    const out = composeTurnInput(null, null, [], "lonely")
    expect(out).toEqual([{ role: "user", content: "lonely" }])
  })
})

describe("GeminiAdapter trace wiring", () => {
  let wss: WebSocketServer | null = null
  let adapter: GeminiAdapter | null = null

  afterEach(async () => {
    adapter?.disconnect()
    adapter = null
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()))
      wss = null
    }
  })

  it("exposes a resume preamble that includes the most recent verbatim turn", async () => {
    process.env.GEMINI_API_KEY = "test-key"
    wss = await mountTrivialMockUpstream("gemini")

    const longHistory = makeHistory(16)
    adapter = new GeminiAdapter()
    ;(adapter as unknown as { wsUrlOverride: string }).wsUrlOverride = `ws://localhost:${(wss.address() as { port: number }).port}`
    await adapter.connect(geminiConfig(longHistory), () => {})

    const preamble = adapter.getResumePreamble?.() ?? ""
    expect(preamble.length).toBeGreaterThan(0)
    expect(preamble).toContain("turn 15")
  })

  it("flows preamble + base instructions into the composed trace input", async () => {
    process.env.GEMINI_API_KEY = "test-key"
    wss = await mountTrivialMockUpstream("gemini")

    adapter = new GeminiAdapter()
    ;(adapter as unknown as { wsUrlOverride: string }).wsUrlOverride = `ws://localhost:${(wss.address() as { port: number }).port}`
    await adapter.connect(geminiConfig(makeHistory(16)), () => {})

    const preamble = adapter.getResumePreamble?.() ?? ""
    const tracer = new TurnTracer()
    tracer.startSession("session-1", "user-1", "gemini-test", "BASE_INSTRUCTIONS")
    tracer.setSessionPreamble(preamble)
    tracer.setResumeHistory(adapter.getResumeHistory?.() ?? [])

    const composed = composeTurnInput(
      "BASE_INSTRUCTIONS",
      preamble,
      adapter.getResumeHistory?.() ?? [],
      "current user utterance",
    )

    expect(composed[0].role).toBe("system")
    expect(composed[0].content).toMatch(/^BASE_INSTRUCTIONS/)
    expect(composed[0].content).toContain("turn 15")
    expect(composed[composed.length - 1]).toEqual({ role: "user", content: "current user utterance" })
  })
})

describe("OpenAIAdapter trace wiring", () => {
  let wss: WebSocketServer | null = null
  let adapter: OpenAIAdapter | null = null

  afterEach(async () => {
    adapter?.disconnect()
    adapter = null
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()))
      wss = null
    }
  })

  it("exposes recent verbatim turns to the tracer", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    wss = await mountTrivialMockUpstream("openai")

    const history = [
      { role: "user" as const, text: "where did we leave off?" },
      { role: "assistant" as const, text: "we were debugging the trace input" },
      { role: "user" as const, text: "right, the system block" },
      { role: "assistant" as const, text: "yes, missing the preamble" },
    ]
    adapter = new OpenAIAdapter({
      providerName: "openai-test",
      realtimeUrl: `ws://localhost:${(wss.address() as { port: number }).port}`,
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-realtime-mini",
      defaultVoice: "marin",
      authHeaders: {},
      sessionFormat: "openai",
    })
    await adapter.connect({
      type: "session.config",
      provider: "openai",
      voice: "marin",
      brainAgent: "none",
      apiKey: "test",
      conversationHistory: history,
    }, () => {})

    const exposed = adapter.getResumeHistory?.() ?? []
    expect(exposed).toHaveLength(history.length)
    expect(exposed[0].text).toBe(history[0].text)
    expect(exposed[exposed.length - 1].text).toBe(history[history.length - 1].text)
  })
})

// --- helpers ---

function mountTrivialMockUpstream(kind: "gemini" | "openai"): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 })
    server.on("connection", (ws: WsSocket) => {
      if (kind === "gemini") {
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw))
          if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }))
        })
      } else {
        ws.send(JSON.stringify({ type: "session.created" }))
      }
    })
    server.on("listening", () => resolve(server))
  })
}

function makeHistory(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `turn ${i}`,
  }))
}

function geminiConfig(history: { role: "user" | "assistant", text: string }[]): SessionConfigEvent {
  return {
    type: "session.config",
    provider: "gemini",
    voice: "Zephyr",
    brainAgent: "none",
    apiKey: "test",
    conversationHistory: history,
  }
}
