import { describe, expect, it } from "vitest"
import { OpenAIAdapter } from "../../src/adapters/openai.js"
import { XAIAdapter } from "../../src/adapters/xai.js"

// OpenAI Realtime defaults to server_vad with start-of-speech interrupting the
// active response. Speaker output bleeds back through the client mic, gets
// transcribed, and the model interrupts ITSELF. While the assistant is emitting
// audio we drop mic frames upstream; the gate releases the instant the audio
// output ends so the next turn's barge-in still lands cleanly. The same adapter
// powers the xAI subclass — both dialects must gate.

type UpstreamEvent = Record<string, unknown>

function audioFrames(captured: UpstreamEvent[]): UpstreamEvent[] {
  return captured.filter((e) => e.type === "input_audio_buffer.append")
}

describe("OpenAIAdapter mic gating during assistant speech", () => {
  it("forwards mic frames when no assistant audio is in flight", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    for (let i = 0; i < 5; i++) adapter.sendAudio(`frame-${i}`)

    expect(audioFrames(getCaptured(adapter))).toHaveLength(5)
  })

  it("drops mic frames once the model starts emitting audio, resumes after response.done", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.output_audio.delta", delta: "model-audio-1" })

    resetCaptured(adapter)
    for (let i = 0; i < 5; i++) adapter.sendAudio(`frame-${i}`)
    expect(audioFrames(getCaptured(adapter))).toHaveLength(0)

    emit(adapter, { type: "response.done", response: { status: "completed" } })

    resetCaptured(adapter)
    for (let i = 0; i < 3; i++) adapter.sendAudio(`post-${i}`)
    expect(audioFrames(getCaptured(adapter))).toHaveLength(3)
  })

  it("releases the gate on response.output_audio.done (GA end-of-audio signal)", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.output_audio.delta", delta: "a" })

    resetCaptured(adapter)
    adapter.sendAudio("gated")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(0)

    emit(adapter, { type: "response.output_audio.done" })

    resetCaptured(adapter)
    adapter.sendAudio("open")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(1)
  })

  it("releases the gate on the legacy response.audio.done signal too", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.audio.delta", delta: "a" })

    resetCaptured(adapter)
    adapter.sendAudio("gated")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(0)

    emit(adapter, { type: "response.audio.done" })

    resetCaptured(adapter)
    adapter.sendAudio("open")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(1)
  })

  it("releases the gate when the client cancels the response (explicit barge-in)", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.output_audio.delta", delta: "a" })

    resetCaptured(adapter)
    adapter.cancelResponse()

    adapter.sendAudio("after-cancel")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(1)
  })

  it("releases the gate when an upstream error lands so the next turn isn't permanently muted", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.output_audio.delta", delta: "a" })
    emit(adapter, { type: "error", error: { message: "boom" } })

    resetCaptured(adapter)
    adapter.sendAudio("after-error")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(1)
  })

  it("resets the gate on disconnect so a re-used adapter instance starts clean", () => {
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.output_audio.delta", delta: "a" })

    adapter.disconnect()

    expect((adapter as unknown as { assistantSpeaking: boolean }).assistantSpeaking).toBe(false)
    expect((adapter as unknown as { droppedMicFramesWhileSpeaking: number }).droppedMicFramesWhileSpeaking).toBe(0)
  })

  it("xAI subclass inherits the gate (same adapter, dialect-agnostic)", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    emit(adapter, { type: "response.audio.delta", delta: "x" })

    resetCaptured(adapter)
    for (let i = 0; i < 4; i++) adapter.sendAudio(`x-${i}`)
    expect(audioFrames(getCaptured(adapter))).toHaveLength(0)

    // xAI's backup flush path: response.audio.done must also release the gate.
    emit(adapter, { type: "response.audio.done" })

    resetCaptured(adapter)
    adapter.sendAudio("x-after")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(1)
  })

  it("xAI flush behavior on response.audio.done is preserved alongside the new gate release", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    adapter.injectContext("real result")
    emit(adapter, { type: "response.output_audio.delta", delta: "x" })
    resetCaptured(adapter)

    emit(adapter, { type: "response.audio.done" })

    // xAI flush still fires the deferred response.create — gate change must
    // not have broken the existing backup-flush logic.
    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])

    adapter.sendAudio("x-open")
    expect(audioFrames(getCaptured(adapter))).toHaveLength(1)
  })
})

function getCaptured(adapter: object): UpstreamEvent[] {
  return (adapter as unknown as { capturedEvents: UpstreamEvent[] }).capturedEvents
}

function setUpCapture(adapter: object) {
  const state = adapter as unknown as {
    capturedEvents: UpstreamEvent[]
    sendUpstream: (event: UpstreamEvent) => boolean
  }
  state.capturedEvents = []
  state.sendUpstream = (event) => {
    state.capturedEvents.push(event)
    return true
  }
}

function resetCaptured(adapter: object) {
  getCaptured(adapter).length = 0
}

function emit(adapter: object, event: Record<string, unknown>) {
  ;(adapter as unknown as { handleUpstreamEvent: (e: Record<string, unknown>) => void }).handleUpstreamEvent(event)
}
