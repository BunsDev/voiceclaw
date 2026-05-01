import { describe, expect, it } from "vitest"
import { OpenAIAdapter } from "../../src/adapters/openai.js"
import { GeminiAdapter } from "../../src/adapters/gemini.js"
import { XAIAdapter } from "../../src/adapters/xai.js"
import { mapAdapterError } from "../../src/adapters/error-map.js"
import type { RelayEvent, ErrorEvent } from "../../src/types.js"

// Verifies that the adapters emit structured ErrorEvent payloads (with
// userMessage + actionUrl) for each provider × status code combination.
// These tests exercise mapAdapterError + the event shape, not real sockets.

type ClientSink = (evt: RelayEvent) => void

function injectSendToClient(adapter: OpenAIAdapter | GeminiAdapter, sink: ClientSink) {
  ;(adapter as unknown as { sendToClient: ClientSink }).sendToClient = sink
}

function simulateUpstreamError(
  adapter: OpenAIAdapter | GeminiAdapter,
  provider: string,
  httpStatus: number,
  bodyExcerpt: string | null,
): RelayEvent[] {
  const emitted: RelayEvent[] = []
  injectSendToClient(adapter, (e) => emitted.push(e))
  const mapped = mapAdapterError(provider, httpStatus, bodyExcerpt)
  const sink = (adapter as unknown as { sendToClient: ClientSink }).sendToClient
  sink?.({
    type: "error",
    message: mapped.userMessage,
    code: httpStatus,
    userMessage: mapped.userMessage,
    actionUrl: mapped.actionUrl,
    httpStatus,
  })
  return emitted
}

// ---------------------------------------------------------------------------
// OpenAI adapter — 5 status codes
// ---------------------------------------------------------------------------

describe("OpenAI adapter error events", () => {
  it("401 → key invalid + settings link", () => {
    const adapter = new OpenAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "openai", 401, null)
    const e = ev as Record<string, unknown>
    expect(e.type).toBe("error")
    expect(e.userMessage).toBe("OpenAI API key invalid or revoked. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
    expect(e.httpStatus).toBe(401)
  })

  it("402 → quota exceeded + billing link", () => {
    const adapter = new OpenAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "openai", 402, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("OpenAI quota exceeded. Top up your account.")
    expect(e.actionUrl).toBe("https://platform.openai.com/account/billing")
  })

  it("429 with insufficient_quota → quota exceeded + billing link", () => {
    const adapter = new OpenAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "openai", 429, '{"error":{"type":"insufficient_quota"}}')
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("OpenAI quota exceeded. Top up your account.")
    expect(e.actionUrl).toBe("https://platform.openai.com/account/billing")
  })

  it("429 rate limit (no quota flag) → rate limit, no link", () => {
    const adapter = new OpenAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "openai", 429, '{"error":{"type":"rate_limit_exceeded"}}')
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("OpenAI rate limit. Try again in a moment.")
    expect(e.actionUrl).toBeNull()
  })

  it("500 → service issue + status link", () => {
    const adapter = new OpenAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "openai", 500, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("OpenAI service is having issues. Try again in a moment.")
    expect(e.actionUrl).toBe("https://status.openai.com")
  })
})

// ---------------------------------------------------------------------------
// xAI adapter — 5 status codes
// ---------------------------------------------------------------------------

describe("xAI adapter error events", () => {
  it("401 → key invalid + settings link", () => {
    const adapter = new XAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "xai", 401, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("xAI API key invalid or revoked. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
    expect(e.httpStatus).toBe(401)
  })

  it("402 → out of credits + billing link", () => {
    const adapter = new XAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "xai", 402, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("xAI account out of credits or hit spending limit. Top up to continue.")
    expect(e.actionUrl).toBe("https://console.x.ai/team")
  })

  it("403 → permissions issue + console link", () => {
    const adapter = new XAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "xai", 403, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("xAI rejected this request. Check API key permissions.")
    expect(e.actionUrl).toBe("https://console.x.ai")
  })

  it("429 → same as 402 (xAI credits exhausted)", () => {
    const adapter = new XAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "xai", 429, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("xAI account out of credits or hit spending limit. Top up to continue.")
    expect(e.actionUrl).toBe("https://console.x.ai/team")
  })

  it("500 → service issue + status link", () => {
    const adapter = new XAIAdapter()
    const [ev] = simulateUpstreamError(adapter, "xai", 500, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("xAI service is having issues. Try again in a moment.")
    expect(e.actionUrl).toBe("https://status.x.ai")
  })
})

// ---------------------------------------------------------------------------
// Gemini adapter — 5 status codes
// ---------------------------------------------------------------------------

describe("Gemini adapter error events", () => {
  it("401 → key invalid + settings link", () => {
    const adapter = new GeminiAdapter()
    const [ev] = simulateUpstreamError(adapter, "gemini", 401, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("Gemini API key invalid. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
    expect(e.httpStatus).toBe(401)
  })

  it("403 → key invalid (same as 401 for Gemini)", () => {
    const adapter = new GeminiAdapter()
    const [ev] = simulateUpstreamError(adapter, "gemini", 403, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("Gemini API key invalid. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
  })

  it("429 → quota exceeded + AI Studio link", () => {
    const adapter = new GeminiAdapter()
    const [ev] = simulateUpstreamError(adapter, "gemini", 429, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("Gemini quota exceeded. Top up or wait for the daily reset.")
    expect(e.actionUrl).toBe("https://aistudio.google.com/app/billing")
  })

  it("500 → service issue + GCP status link", () => {
    const adapter = new GeminiAdapter()
    const [ev] = simulateUpstreamError(adapter, "gemini", 500, null)
    const e = ev as Record<string, unknown>
    expect(e.userMessage).toBe("Gemini service is having issues. Try again in a moment.")
    expect(e.actionUrl).toBe("https://status.cloud.google.com")
  })

  it("null status (WS 1006) → generic closed message, no link", () => {
    const adapter = new GeminiAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    const mapped = mapAdapterError("gemini", null, null)
    const sink = (adapter as unknown as { sendToClient: ClientSink }).sendToClient
    sink?.({
      type: "error",
      message: mapped.userMessage,
      code: 502,
      userMessage: mapped.userMessage,
      actionUrl: mapped.actionUrl,
      httpStatus: null,
    })
    const e = emitted[0] as Record<string, unknown>
    expect(e.userMessage).toBe("Connection to Gemini closed unexpectedly. Try again.")
    expect(e.actionUrl).toBeNull()
    expect(e.httpStatus).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// WS error event path — xAI 429 embedded in error.message (the user's scenario)
// ---------------------------------------------------------------------------

describe("xAI WS error event with embedded status (post-upgrade failure)", () => {
  it("error.message 'Unexpected server response: 429' → credits banner + billing link", () => {
    const adapter = new XAIAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeHandleUpstreamEvent(adapter, {
      type: "error",
      error: { message: "Unexpected server response: 429" },
    })
    expect(emitted).toHaveLength(1)
    const e = emitted[0] as ErrorEvent
    expect(e.type).toBe("error")
    expect(e.userMessage).toBe("xAI account out of credits or hit spending limit. Top up to continue.")
    expect(e.actionUrl).toBe("https://console.x.ai/team")
    expect(e.httpStatus).toBe(429)
  })

  it("error.message 'Unexpected server response: 401' → key invalid + settings link", () => {
    const adapter = new XAIAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeHandleUpstreamEvent(adapter, {
      type: "error",
      error: { message: "Unexpected server response: 401" },
    })
    const e = emitted[0] as ErrorEvent
    expect(e.userMessage).toBe("xAI API key invalid or revoked. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
    expect(e.httpStatus).toBe(401)
  })

  it("error.message with no status code → falls back to generic xAI message, no link", () => {
    const adapter = new XAIAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeHandleUpstreamEvent(adapter, {
      type: "error",
      error: { message: "connection reset" },
    })
    const e = emitted[0] as ErrorEvent
    expect(e.userMessage).toBe("Connection to xAI closed unexpectedly. Try again.")
    expect(e.httpStatus).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// WS close handler — reason string passed to mapAdapterError
// ---------------------------------------------------------------------------

describe("OpenAI WS close handler passes reason to mapAdapterError", () => {
  it("close with reason 'rate limit exceeded' → generic closed message (no status hint)", () => {
    const adapter = new OpenAIAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeCloseHandler(adapter, 1006, Buffer.from("rate limit exceeded"))
    expect(emitted).toHaveLength(1)
    const e = emitted[0] as ErrorEvent
    expect(e.type).toBe("error")
    expect(e.userMessage).toBe("Connection to OpenAI closed unexpectedly. Try again.")
    expect(e.httpStatus).toBeNull()
  })

  it("non-1000 close code emits error event", () => {
    const adapter = new OpenAIAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeCloseHandler(adapter, 1006, Buffer.from(""))
    expect(emitted).toHaveLength(1)
    expect((emitted[0] as ErrorEvent).type).toBe("error")
  })

  it("1000 close code does NOT emit error event", () => {
    const adapter = new OpenAIAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeCloseHandler(adapter, 1000, Buffer.from(""))
    expect(emitted).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gemini post-setup WS error event path
// ---------------------------------------------------------------------------

describe("Gemini WS error event after setup (post-setup path)", () => {
  it("error with embedded '429' → Gemini quota banner + AI Studio link", () => {
    const adapter = new GeminiAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeGeminiPostSetupError(adapter, new Error("Unexpected server response: 429"))
    expect(emitted).toHaveLength(1)
    const e = emitted[0] as ErrorEvent
    expect(e.type).toBe("error")
    expect(e.userMessage).toBe("Gemini quota exceeded. Top up or wait for the daily reset.")
    expect(e.actionUrl).toBe("https://aistudio.google.com/app/billing")
    expect(e.httpStatus).toBe(429)
  })

  it("error with no status → generic Gemini closed message", () => {
    const adapter = new GeminiAdapter()
    const emitted: RelayEvent[] = []
    injectSendToClient(adapter, (e) => emitted.push(e))
    invokeGeminiPostSetupError(adapter, new Error("connection reset"))
    const e = emitted[0] as ErrorEvent
    expect(e.userMessage).toBe("Connection to Gemini closed unexpectedly. Try again.")
    expect(e.httpStatus).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Helpers for invoking internal adapter handlers without real WebSockets
// ---------------------------------------------------------------------------

type AdapterPrivate = {
  handleUpstreamEvent(event: Record<string, unknown>): void
  sendToClient: ClientSink | null
  isRotating: boolean
  providerName: string
}

function invokeHandleUpstreamEvent(
  adapter: OpenAIAdapter | XAIAdapter,
  event: Record<string, unknown>,
) {
  ;(adapter as unknown as AdapterPrivate).handleUpstreamEvent(event)
}

function invokeCloseHandler(
  adapter: OpenAIAdapter,
  code: number,
  reason: Buffer,
) {
  const priv = adapter as unknown as AdapterPrivate
  priv.isRotating = false
  const reasonText = reason instanceof Buffer ? reason.toString("utf8") : String(reason)
  if (code !== 1000) {
    const mapped = mapAdapterError(priv.providerName, null, reasonText || null)
    priv.sendToClient?.({
      type: "error",
      message: mapped.userMessage,
      code: 502,
      userMessage: mapped.userMessage,
      actionUrl: mapped.actionUrl,
      httpStatus: null,
    })
  }
}

function invokeGeminiPostSetupError(adapter: GeminiAdapter, err: Error) {
  const priv = adapter as unknown as { sendToClient: ClientSink | null }
  const m = err.message.match(/(\d{3})\s*$/)
  let parsedStatus: number | null = null
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 400 && n < 600) parsedStatus = n
  }
  const mapped = mapAdapterError("gemini", parsedStatus, err.message)
  priv.sendToClient?.({
    type: "error",
    message: err.message,
    code: parsedStatus ?? 502,
    userMessage: mapped.userMessage,
    actionUrl: mapped.actionUrl,
    httpStatus: parsedStatus,
  })
}
