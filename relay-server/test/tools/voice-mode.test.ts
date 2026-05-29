import { describe, expect, it, afterEach } from "vitest"
import { getRelayTools, effectiveVoiceMode } from "../../src/tools/index.js"
import type { SessionConfigEvent, VoiceMode } from "../../src/types.js"

function makeConfig(overrides: Partial<SessionConfigEvent> = {}): SessionConfigEvent {
  return {
    type: "session.config",
    provider: "openai",
    voice: "marin",
    brainAgent: "enabled",
    apiKey: "test-key",
    ...overrides,
  }
}

describe("voiceMode tool gating", () => {
  afterEach(() => {
    delete process.env.TAVILY_API_KEY
  })

  it("defaults to direct mode when voiceMode is missing", () => {
    expect(effectiveVoiceMode(makeConfig())).toBe("direct")
    const names = getRelayTools(makeConfig()).map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
  })

  it("operator mode advertises ask_brain instead of direct tools", () => {
    const tools = getRelayTools(makeConfig({ voiceMode: "operator" }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain("ask_brain")
    expect(names).not.toContain("read")
    expect(names).not.toContain("write")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("bash")
  })

  it("operator mode keeps web_search when Tavily key is set", () => {
    process.env.TAVILY_API_KEY = "tvly-test"
    const names = getRelayTools(makeConfig({ voiceMode: "operator" })).map((t) => t.name).sort()
    expect(names).toEqual(["ask_brain", "echo_tool", "web_search"])
  })

  it("supervisor mode falls back to direct behavior (SCAFFOLD)", () => {
    expect(effectiveVoiceMode(makeConfig({ voiceMode: "supervisor" }))).toBe("direct")
    const names = getRelayTools(makeConfig({ voiceMode: "supervisor" })).map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
    expect(names).not.toContain("ask_brain")
  })

  it("ignores garbage voiceMode values and falls back to direct", () => {
    const cfg = makeConfig({ voiceMode: "nonsense" as unknown as VoiceMode })
    expect(effectiveVoiceMode(cfg)).toBe("direct")
    const names = getRelayTools(cfg).map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
  })
})
