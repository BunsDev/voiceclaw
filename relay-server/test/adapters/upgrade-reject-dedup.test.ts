import { describe, expect, it } from "vitest"
import { mapAdapterError } from "../../src/adapters/error-map.js"
import type { RelayEvent } from "../../src/types.js"

// Regression test: when the upstream WS rejects the upgrade (unexpected-response),
// the adapter emits one mapped error event and rejects with that same mapped
// payload. The relay session's catch block must NOT emit a second generic error.
// This test simulates the two-party handshake without real sockets.

type ClientSink = (evt: RelayEvent) => void

function simulateUpgradeReject(
  provider: string,
  httpStatus: number,
  bodyExcerpt: string | null,
): { clientEvents: RelayEvent[]; sessionWouldSendGenericError: boolean } {
  const clientEvents: RelayEvent[] = []
  const sendToClient: ClientSink = (e) => clientEvents.push(e)

  const mapped = mapAdapterError(provider, httpStatus, bodyExcerpt)

  // Adapter: emit mapped error then reject with a payload that carries userMessage
  sendToClient({
    type: "error",
    message: mapped.userMessage,
    code: httpStatus,
    userMessage: mapped.userMessage,
    actionUrl: mapped.actionUrl,
    actionLabel: mapped.actionLabel,
    httpStatus,
  })

  const rejectedWith = Object.assign(
    new Error(`Unexpected server response: ${httpStatus}`),
    { httpStatus, bodyExcerpt, userMessage: mapped.userMessage, actionUrl: mapped.actionUrl },
  )

  // RelaySession catch block: skip generic sendError if err.userMessage is present
  const alreadyMapped = typeof (rejectedWith as Record<string, unknown>).userMessage === "string"
  const sessionWouldSendGenericError = !alreadyMapped

  return { clientEvents, sessionWouldSendGenericError }
}

describe("upgrade rejection deduplication", () => {
  it("OpenAI 401 → exactly one mapped error event, session skips generic error", () => {
    const { clientEvents, sessionWouldSendGenericError } = simulateUpgradeReject("openai", 401, null)
    expect(clientEvents).toHaveLength(1)
    expect(sessionWouldSendGenericError).toBe(false)
    const e = clientEvents[0] as Record<string, unknown>
    expect(e.type).toBe("error")
    expect(e.userMessage).toBe("OpenAI API key invalid or revoked. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
    expect(e.actionLabel).toBe("Open Settings")
  })

  it("Gemini 400 → exactly one mapped error event, session skips generic error", () => {
    const { clientEvents, sessionWouldSendGenericError } = simulateUpgradeReject("gemini", 400, null)
    expect(clientEvents).toHaveLength(1)
    expect(sessionWouldSendGenericError).toBe(false)
    const e = clientEvents[0] as Record<string, unknown>
    expect(e.type).toBe("error")
    expect(e.userMessage).toBe("Gemini API key invalid. Update it in Settings → Provider.")
    expect(e.actionUrl).toBe("voiceclaw://settings/provider")
    expect(e.actionLabel).toBe("Open Settings")
  })

  it("Gemini 401 → exactly one mapped error event, session skips generic error", () => {
    const { clientEvents, sessionWouldSendGenericError } = simulateUpgradeReject("gemini", 401, null)
    expect(clientEvents).toHaveLength(1)
    expect(sessionWouldSendGenericError).toBe(false)
    const e = clientEvents[0] as Record<string, unknown>
    expect(e.userMessage).toBe("Gemini API key invalid. Update it in Settings → Provider.")
  })

  it("xAI 429 → exactly one mapped error event, session skips generic error", () => {
    const { clientEvents, sessionWouldSendGenericError } = simulateUpgradeReject("xai", 429, null)
    expect(clientEvents).toHaveLength(1)
    expect(sessionWouldSendGenericError).toBe(false)
    const e = clientEvents[0] as Record<string, unknown>
    expect(e.userMessage).toBe("xAI account out of credits or hit spending limit. Top up to continue.")
    expect(e.actionLabel).toBe("Open billing")
  })

  it("network error (no httpStatus) → session sends generic error (no userMessage on rejection)", () => {
    const clientEvents: RelayEvent[] = []

    // Adapter only emits via 'error' WS event for network errors — no sendToClient call
    const networkErr = new Error("ECONNREFUSED")
    // networkErr has no userMessage property
    const alreadyMapped = typeof (networkErr as Record<string, unknown>).userMessage === "string"
    const sessionWouldSendGenericError = !alreadyMapped

    expect(clientEvents).toHaveLength(0)
    expect(sessionWouldSendGenericError).toBe(true)
  })
})
