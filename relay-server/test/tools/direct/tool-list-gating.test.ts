import { describe, expect, it, afterEach } from "vitest"
import { getRelayTools } from "../../../src/tools/index.js"
import type { SessionConfigEvent } from "../../../src/types.js"

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

describe("tool list", () => {
  afterEach(() => {
    delete process.env.TAVILY_API_KEY
  })

  it("exposes the 5 direct-mode tools plus web_search when Tavily is set; never exposes ask_brain", () => {
    process.env.TAVILY_API_KEY = "tvly-test"
    const tools = getRelayTools(makeConfig())
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "web_search", "write"])
    expect(names).not.toContain("ask_brain")
  })

  it("drops web_search when no Tavily key is available", () => {
    const tools = getRelayTools(makeConfig())
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
    expect(names).not.toContain("ask_brain")
    expect(names).not.toContain("web_search")
  })

  it("brainAgent='none' produces the same direct tools", () => {
    const tools = getRelayTools(makeConfig({ brainAgent: "none" }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
  })

  it("direct tools have the expected latency classes", () => {
    const tools = getRelayTools(makeConfig())
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.latencyClass]))
    expect(byName.read).toBe("fast")
    expect(byName.write).toBe("fast")
    expect(byName.edit).toBe("fast")
    expect(byName.bash).toBe("streaming")
  })
})
