import { afterEach, describe, expect, it } from "vitest"
import {
  mountMockGemini,
  pcm16Chunk,
  waitMs,
  type MockHandle,
} from "../helpers/mock-gemini.js"

// Gemini Live's default activityHandling is START_OF_ACTIVITY_INTERRUPTS, so any
// frame its VAD flags as user speech truncates the current model turn. Residual
// TTS bleeding back through the client mic gets transcribed and the model
// interrupts itself. We stop forwarding mic frames upstream while assistant audio
// is in flight; this test pins that contract without touching OpenAI/xAI.

function audioFrame(byte: number = 0xAB): Record<string, unknown> {
  return {
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([byte, byte]).toString("base64") } },
        ],
      },
    },
  }
}

function countAudioMessages(msgs: Record<string, unknown>[]): number {
  return msgs.filter((m) => {
    const ri = m.realtimeInput as Record<string, unknown> | undefined
    return ri?.audio !== undefined
  }).length
}

describe("GeminiAdapter mic gating during assistant speech", () => {
  let mock: MockHandle | null = null

  afterEach(async () => {
    await mock?.dispose()
    mock = null
  })

  it("forwards mic frames when no assistant audio is in flight", async () => {
    mock = await mountMockGemini([{ steps: [] }])

    for (let i = 0; i < 5; i++) mock.adapter.sendAudio(pcm16Chunk(160, i))
    await waitMs(50)

    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(5)
  })

  it("drops mic frames while the model is emitting audio, resumes after turnComplete", async () => {
    mock = await mountMockGemini([
      { steps: [
        { at: 30, msg: audioFrame(0x10) },
        { at: 200, msg: { serverContent: { turnComplete: true } } },
      ] },
    ])

    await waitMs(60) // wait until the assistant-audio frame has arrived
    for (let i = 0; i < 5; i++) mock.adapter.sendAudio(pcm16Chunk(160, i))
    await waitMs(20)
    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(0)

    await waitMs(220) // wait for turnComplete to land
    for (let i = 0; i < 3; i++) mock.adapter.sendAudio(pcm16Chunk(160, 100 + i))
    await waitMs(20)
    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(3)
  })

  it("re-opens the mic on generationComplete even without turnComplete", async () => {
    mock = await mountMockGemini([
      { steps: [
        { at: 30, msg: audioFrame(0x20) },
        { at: 120, msg: { serverContent: { generationComplete: true } } },
      ] },
    ])

    await waitMs(60)
    mock.adapter.sendAudio(pcm16Chunk(160, 1))
    await waitMs(20)
    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(0)

    await waitMs(120)
    mock.adapter.sendAudio(pcm16Chunk(160, 2))
    await waitMs(20)
    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(1)
  })

  it("re-opens the mic on interrupted so a real barge-in can land cleanly on the next turn", async () => {
    mock = await mountMockGemini([
      { steps: [
        { at: 30, msg: audioFrame(0x30) },
        { at: 100, msg: { serverContent: { interrupted: true } } },
      ] },
    ])

    await waitMs(60)
    mock.adapter.sendAudio(pcm16Chunk(160, 1))
    await waitMs(20)
    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(0)

    await waitMs(100)
    mock.adapter.sendAudio(pcm16Chunk(160, 2))
    await waitMs(20)
    expect(countAudioMessages(mock.messagesPerSocket[0])).toBe(1)
  })
})
