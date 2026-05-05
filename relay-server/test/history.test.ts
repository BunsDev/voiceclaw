import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildHistorySplit } from "../src/history.js"
import type { HistoryMessage } from "../src/history.js"

// Enough turns to force summarization (>16 messages = >8 verbatim turns)
function makeHistory(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `Turn ${i + 1}`,
  }))
}

const RECENT_COUNT = 16 // RECENT_TURNS_VERBATIM * 2

describe("buildHistorySplit — summarization routing", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv("XAI_API_KEY", "test-xai-key")
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key")
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("calls xAI summarizer for xai provider", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "xAI summary" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    const history = makeHistory(RECENT_COUNT + 4)
    const result = await buildHistorySplit(history, "xai")

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]]
    expect(url).toContain("api.x.ai")
    expect(result.summary).toBe("xAI summary")
    expect(result.recent).toHaveLength(RECENT_COUNT)
  })

  it("calls Gemini summarizer for gemini provider", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Gemini summary" }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    const history = makeHistory(RECENT_COUNT + 4)
    const result = await buildHistorySplit(history, "gemini")

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]]
    expect(url).toContain("generativelanguage.googleapis.com")
    expect(result.summary).toBe("Gemini summary")
  })

  it("falls back to truncated raw transcript when summarizer fails", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"))
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const history = makeHistory(RECENT_COUNT + 4)
    const result = await buildHistorySplit(history, "xai")

    expect(result.summary).toBeTruthy()
    expect(logSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("No summarizer produced output"),
    )

    logSpy.mockRestore()
  })

  it("skips summarization when history is short enough", async () => {
    const history = makeHistory(RECENT_COUNT)
    const result = await buildHistorySplit(history, "xai")

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.summary).toBeNull()
    expect(result.recent).toHaveLength(RECENT_COUNT)
  })
})
