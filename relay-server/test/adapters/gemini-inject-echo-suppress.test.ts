import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { WebSocketServer, WebSocket as WsSocket } from "ws"
import { GeminiAdapter } from "../../src/adapters/gemini.js"
import type { SessionConfigEvent } from "../../src/types.js"

interface MockUpstream {
  port: number
  setups: Record<string, unknown>[]
  realtimeInputs: Record<string, unknown>[]
  emitToClient: (msg: Record<string, unknown>) => void
  close: () => Promise<void>
}

type RelayEvent = { type: string, [k: string]: unknown }

describe("GeminiAdapter inject-context echo suppression", () => {
  let upstream: MockUpstream | null = null
  const adapters: GeminiAdapter[] = []

  beforeAll(() => {
    process.env.GEMINI_API_KEY = "test-key"
    process.env.OPENAI_API_KEY = ""
  })

  afterEach(async () => {
    for (const a of adapters) a.disconnect()
    adapters.length = 0
    if (upstream) {
      await upstream.close()
      upstream = null
    }
  })

  it("forwards injected text to Gemini via realtimeInput.text", async () => {
    upstream = await mountUpstream()
    const events: RelayEvent[] = []
    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(makeConfig(), (e) => events.push(e as RelayEvent))
    await waitMs(50)

    const inject = "[bash result for command: ls]\n{\"ok\":true}\n\nNarrate the outcome to the user."
    adapter.injectContext(inject)
    await waitMs(50)

    const text = upstream.realtimeInputs.find((m) => {
      const r = m as { text?: unknown }
      return typeof r.text === "string"
    }) as { text: string } | undefined
    expect(text?.text).toBe(inject)
  })

  it("suppresses transcript events when Gemini echoes the injection as input transcription", async () => {
    upstream = await mountUpstream()
    const events: RelayEvent[] = []
    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(makeConfig(), (e) => events.push(e as RelayEvent))
    await waitMs(50)

    const inject = "[bash result for command: ls]\n{\"stdout\":\"a\\nb\\nc\"}\n\nNarrate the outcome to the user."
    adapter.injectContext(inject)
    await waitMs(20)

    // Gemini Live echoes the injected text back to us as inputTranscription
    // deltas. The relay must NOT forward those to the client — otherwise the
    // raw "[bash result for command…] {…} Narrate the outcome to the user."
    // envelope shows up as a user bubble in the transcript.
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject } } })
    await waitMs(20)

    const transcriptEvents = events.filter(
      (e) => e.type === "transcript.delta" || e.type === "transcript.done",
    )
    expect(transcriptEvents).toHaveLength(0)
    // The echo also should not start a user turn — there was no real speech.
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(0)
  })

  it("suppresses echo split across multiple inputTranscription deltas", async () => {
    upstream = await mountUpstream()
    const events: RelayEvent[] = []
    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(makeConfig(), (e) => events.push(e as RelayEvent))
    await waitMs(50)

    const inject = "[bash result for command: pwd]\n{\"stdout\":\"/tmp\"}\n\nNarrate the outcome to the user."
    adapter.injectContext(inject)

    // Stream the echo back in arbitrary chunks the way Gemini deltas land.
    const mid = Math.floor(inject.length / 3)
    const end = Math.floor((inject.length * 2) / 3)
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject.slice(0, mid) } } })
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject.slice(mid, end) } } })
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject.slice(end) } } })
    await waitMs(40)

    expect(events.filter((e) => e.type === "transcript.delta")).toHaveLength(0)
    expect(events.filter((e) => e.type === "transcript.done")).toHaveLength(0)
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(0)
  })

  it("forwards genuine user speech that follows the echo as a normal transcript", async () => {
    upstream = await mountUpstream()
    const events: RelayEvent[] = []
    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(makeConfig(), (e) => events.push(e as RelayEvent))
    await waitMs(50)

    const inject = "[bash result for command: ls]\n{\"ok\":true}\n\nNarrate the outcome to the user."
    adapter.injectContext(inject)
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject } } })
    await waitMs(20)

    // Real user speech arrives next — must NOT be suppressed.
    upstream.emitToClient({ serverContent: { inputTranscription: { text: "Got it, thanks" } } })
    await waitMs(20)

    const deltas = events.filter((e) => e.type === "transcript.delta")
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ role: "user", text: "Got it, thanks" })
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1)
  })

  it("only suppresses the matching prefix of a mixed delta", async () => {
    upstream = await mountUpstream()
    const events: RelayEvent[] = []
    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(makeConfig(), (e) => events.push(e as RelayEvent))
    await waitMs(50)

    const inject = "[bash result]\nNarrate the outcome to the user."
    adapter.injectContext(inject)

    // Gemini may concatenate the tail of the echo with the start of real
    // user speech into one delta. The leading injection slice must be
    // suppressed, the trailing real speech must be forwarded.
    const echoTail = inject.slice(-15)
    const realSpeech = "And by the way"
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject.slice(0, -15) } } })
    upstream.emitToClient({ serverContent: { inputTranscription: { text: echoTail + realSpeech } } })
    await waitMs(40)

    const deltas = events.filter((e) => e.type === "transcript.delta")
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ role: "user", text: realSpeech })
  })

  it("clears suppression state on turnComplete", async () => {
    upstream = await mountUpstream()
    const events: RelayEvent[] = []
    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(makeConfig(), (e) => events.push(e as RelayEvent))
    await waitMs(50)

    const inject = "[bash result] Narrate the outcome to the user."
    adapter.injectContext(inject)
    // Only the first half of the echo arrives before the turn ends.
    upstream.emitToClient({ serverContent: { inputTranscription: { text: inject.slice(0, 12) } } })
    upstream.emitToClient({ serverContent: { turnComplete: true } })
    await waitMs(20)

    // A new utterance later that happens to share the un-consumed prefix
    // must NOT be suppressed — the buffer was reset on turnComplete.
    const sharedPrefix = inject.slice(12, 24)
    upstream.emitToClient({ serverContent: { inputTranscription: { text: sharedPrefix } } })
    await waitMs(20)

    const deltas = events.filter((e) => e.type === "transcript.delta")
    expect(deltas.map((d) => d.text)).toContain(sharedPrefix)
  })
})

async function mountUpstream(): Promise<MockUpstream> {
  const setups: Record<string, unknown>[] = []
  const realtimeInputs: Record<string, unknown>[] = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()))
  const address = wss.address()
  const port = typeof address === "object" && address ? address.port : 0
  let activeSocket: WsSocket | null = null

  wss.on("connection", (ws: WsSocket) => {
    activeSocket = ws
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>
      if ("setup" in msg) {
        setups.push(msg.setup as Record<string, unknown>)
        ws.send(JSON.stringify({ setupComplete: {} }))
        return
      }
      if ("realtimeInput" in msg) {
        realtimeInputs.push(msg.realtimeInput as Record<string, unknown>)
      }
    })
    ws.on("close", () => {
      if (activeSocket === ws) activeSocket = null
    })
  })

  return {
    port,
    setups,
    realtimeInputs,
    emitToClient: (msg) => {
      if (activeSocket && activeSocket.readyState === WsSocket.OPEN) {
        activeSocket.send(JSON.stringify(msg))
      }
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  }
}

function makeConfig(): SessionConfigEvent {
  return {
    type: "session.config",
    provider: "gemini",
    model: "gemini-3.1-flash-live-preview",
    voice: "Zephyr",
    apiKey: "test",
    brainAgent: "none",
    deviceContext: { timezone: "UTC", locale: "en-US", deviceModel: "mock" },
  }
}

function makeAdapter(pool: GeminiAdapter[], port: number): GeminiAdapter {
  const adapter = new GeminiAdapter()
  ;(adapter as unknown as { wsUrlOverride: string }).wsUrlOverride = `ws://localhost:${port}`
  pool.push(adapter)
  return adapter
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
