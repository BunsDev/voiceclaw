#!/usr/bin/env node
// Pre-recorded voice samples for the Settings voice picker.
//
// xAI does not expose a one-shot HTTP TTS endpoint the way Gemini does
// (`gemini-3.1-flash-tts-preview:generateContent`), so we generate the
// samples once via the Realtime WebSocket and commit the resulting WAVs
// as bundled assets under `desktop/resources/voice-previews/xai/`.
//
// Usage:
//   XAI_API_KEY=... node desktop/scripts/generate-xai-voice-previews.mjs
//
// Re-run only if the voice list changes or xAI rolls a new model that
// changes how a voice sounds. The runtime preview path (Settings) reads
// straight from the bundled WAVs — no network, no API key needed.

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

const VOICES = ["eve", "ara", "rex", "sal", "leo"]
const PROMPT_TEXT = `Hi, I'm here.`
const MODEL = "grok-voice-think-fast-1.0"
const REALTIME_URL = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(MODEL)}`
const SAMPLE_RATE = 24000
const PER_VOICE_TIMEOUT_MS = 30_000

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, "..", "resources", "voice-previews", "xai")

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) {
    console.error("[xai-previews] XAI_API_KEY is required")
    process.exit(2)
  }
  await mkdir(outDir, { recursive: true })
  for (const voice of VOICES) {
    process.stdout.write(`[xai-previews] ${voice} … `)
    const pcm = await captureVoice(apiKey, voice)
    const wav = pcmToWav(pcm, SAMPLE_RATE)
    const path = resolve(outDir, `${voice}.wav`)
    await writeFile(path, wav)
    console.log(`${pcm.length} bytes pcm → ${path}`)
  }
  console.log("[xai-previews] done")
}

function captureVoice(apiKey, voice) {
  return new Promise((resolveVoice, rejectVoice) => {
    const ws = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const frames = []
    let configured = false
    let prompted = false
    let settled = false

    const finish = (result, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // ignore
      }
      err ? rejectVoice(err) : resolveVoice(result)
    }

    const timer = setTimeout(
      () => finish(null, new Error(`timeout waiting for audio (voice=${voice})`)),
      PER_VOICE_TIMEOUT_MS,
    )

    ws.on("open", () => {
      // First message tells xAI how this session should behave. Audio-only
      // output, PCM/24k, no VAD (we never send mic audio), no tools, no
      // transcription. Instructions are deliberately minimal so the model
      // reads PROMPT_TEXT verbatim and stops.
      send(ws, {
        type: "session.update",
        session: {
          instructions:
            "You are a voice sample generator. Speak only what the user message contains, exactly once, then stop. Do not add any extra words.",
          voice,
          turn_detection: null,
          tools: [],
          tool_choice: "none",
          audio: {
            input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
            output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
          },
        },
      })
    })

    ws.on("message", (data) => {
      let event
      try {
        event = JSON.parse(data.toString("utf8"))
      } catch {
        return
      }
      switch (event.type) {
        case "session.updated":
          if (configured) return
          configured = true
          // Inject the line we want spoken, then ask for one response.
          send(ws, {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: PROMPT_TEXT }],
            },
          })
          send(ws, { type: "response.create" })
          prompted = true
          return
        case "response.audio.delta":
        case "response.output_audio.delta":
          if (typeof event.delta === "string") {
            frames.push(Buffer.from(event.delta, "base64"))
          }
          return
        case "response.done":
        case "response.audio.done":
        case "response.output_audio.done":
          if (frames.length > 0) finish(Buffer.concat(frames))
          return
        case "error":
          finish(null, new Error(formatXaiError(event)))
          return
      }
    })

    ws.on("error", (err) => finish(null, err))
    ws.on("close", () => {
      if (settled) return
      if (frames.length > 0) finish(Buffer.concat(frames))
      else
        finish(
          null,
          new Error(
            `socket closed before audio (voice=${voice}, configured=${configured}, prompted=${prompted})`,
          ),
        )
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws, message) {
  ws.send(JSON.stringify(message))
}

function formatXaiError(event) {
  const err = event.error ?? event
  const msg = err?.message ?? "xAI error"
  const code = err?.code ? ` (${err.code})` : ""
  return `xAI: ${msg}${code}`
}

function pcmToWav(pcm, sampleRate) {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = pcm.length
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write("WAVE", 8)
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(dataSize, 40)
  pcm.copy(buffer, 44)
  return buffer
}
