import { describe, expect, it } from "vitest"
import { XAIAdapter } from "../../src/adapters/xai.js"

type UpstreamEvent = Record<string, unknown>

// xAI's beta dialect doesn't reliably emit response.done after a placeholder
// tool result is returned (e.g. `{"status": "running"}`) and the real result
// is later injected via injectContext. Without a backup flush trigger, the
// deferred response.create strands and the model never speaks the result.
// These tests pin the deferral behavior across both the canonical (response.done)
// and the backup (response.audio.done / response.output_audio.done) signals.

describe("XAIAdapter deferred response.create lifecycle", () => {
  it("flushes a deferred response.create on response.audio.done when response.done never fires (the bug)", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })

    // Simulate the async-tool flow: bash's placeholder went through
    // sendToolResult("running"), a follow-up response started, and the real
    // bash result lands via injectContext while that follow-up response is
    // still streaming.
    adapter.injectContext("[bash result for command: ls]\n{\"stdout\":\"file.txt\"}\n\nNarrate the outcome to the user.")

    // injectContext sent conversation.item.create + deferred response.create
    expect(getCaptured(adapter)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "[bash result for command: ls]\n{\"stdout\":\"file.txt\"}\n\nNarrate the outcome to the user.",
          }],
        },
      },
    ])
    resetCaptured(adapter)

    // xAI beta dialect: response.audio.done arrives but response.done never does
    emit(adapter, { type: "response.audio.done" })

    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])
  })

  it("flushes a deferred response.create on response.output_audio.done (GA event name) for xAI", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    adapter.injectContext("real result")
    resetCaptured(adapter)

    emit(adapter, { type: "response.output_audio.done" })

    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])
  })

  it("still flushes on response.done when the canonical signal does fire", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    adapter.injectContext("real result")
    resetCaptured(adapter)

    emit(adapter, { type: "response.done" })

    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])
  })

  it("does not double-fire response.create when audio.done is followed by response.done", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    adapter.injectContext("real result")
    resetCaptured(adapter)

    emit(adapter, { type: "response.audio.done" })
    emit(adapter, { type: "response.done" })

    // Exactly one response.create — the second event is a no-op because
    // pendingResponseCreate was cleared by the first flush.
    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])
  })

  it("flushes a deferred response.create after a placeholder tool result on response.audio.done", () => {
    const adapter = new XAIAdapter()
    setUpCapture(adapter)

    // Simulate the async streaming tool path: model called bash, relay sent a
    // "running" placeholder via sendToolResult while bash executes.
    emit(adapter, { type: "response.created" })
    ;(adapter as unknown as { pendingToolCalls: number }).pendingToolCalls = 1
    adapter.sendToolResult("call-bash-1", "{\"status\":\"running\"}")

    // sendToolResult emits the function_call_output and queues a deferred
    // response.create because the response is still active.
    expect(getCaptured(adapter)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-bash-1",
          output: "{\"status\":\"running\"}",
        },
      },
    ])
    resetCaptured(adapter)

    // xAI: response.audio.done lands, response.done never does
    emit(adapter, { type: "response.audio.done" })

    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])
  })
})

describe("OpenAIAdapter is unaffected by the xAI backup flush", () => {
  it("does NOT flush on response.audio.done for the OpenAI dialect (response.done remains canonical)", async () => {
    const { OpenAIAdapter } = await import("../../src/adapters/openai.js")
    const adapter = new OpenAIAdapter()
    setUpCapture(adapter)

    emit(adapter, { type: "response.created" })
    adapter.injectContext("text")
    resetCaptured(adapter)

    emit(adapter, { type: "response.output_audio.done" })

    // OpenAI GA reliably emits response.done; audio.done must not cause an
    // early flush that races the canonical lifecycle.
    expect(getCaptured(adapter)).toEqual([])

    emit(adapter, { type: "response.done" })
    expect(getCaptured(adapter)).toEqual([{ type: "response.create" }])
  })
})

function getCaptured(adapter: XAIAdapter): UpstreamEvent[] {
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
  (adapter as unknown as { capturedEvents: UpstreamEvent[] }).capturedEvents.length = 0
}

function emit(adapter: object, event: Record<string, unknown>) {
  ;(adapter as unknown as { handleUpstreamEvent: (e: Record<string, unknown>) => void }).handleUpstreamEvent(event)
}
