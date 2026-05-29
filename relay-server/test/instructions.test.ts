import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInstructions } from "../src/instructions.js"
import {
  ensureWorkspace,
  getAgentsMdPath,
  getFactsPath,
  getIdentityPath,
  getMemoryDir,
  getSoulPath,
  getWorkspaceRoot,
} from "../src/workspace.js"
import type { SessionConfigEvent } from "../src/types.js"

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

describe("buildInstructions", () => {
  let tmpRoot: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "voiceclaw-instr-"))
    prevEnv = process.env.VOICECLAW_WORKSPACE
    process.env.VOICECLAW_WORKSPACE = join(tmpRoot, "workspace")
    await ensureWorkspace()
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.VOICECLAW_WORKSPACE
    else process.env.VOICECLAW_WORKSPACE = prevEnv
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("includes the direct-tools preamble in direct mode (default)", () => {
    const instructions = buildInstructions(makeConfig())
    expect(instructions).toMatch(/Your direct tools/)
    expect(instructions).toMatch(/read.*to inspect files/i)
    expect(instructions).toMatch(/write.*and.*edit/i)
    expect(instructions).toMatch(/bash/)
    expect(instructions).toMatch(/web_search/)
    expect(instructions).not.toMatch(/Your brain agent/)
  })

  it("swaps to the brain agent preamble in operator mode", () => {
    const instructions = buildInstructions(makeConfig({ voiceMode: "operator" }))
    expect(instructions).toMatch(/Your brain agent/)
    expect(instructions).toMatch(/ask_brain/)
    expect(instructions).toMatch(/How ask_brain returns/)
    expect(instructions).toMatch(/Memory/)
    expect(instructions).not.toMatch(/Your direct tools/)
  })

  it("supervisor mode (SCAFFOLD) falls back to the direct preamble", () => {
    const instructions = buildInstructions(makeConfig({ voiceMode: "supervisor" }))
    expect(instructions).toMatch(/Your direct tools/)
    expect(instructions).not.toMatch(/Your brain agent/)
  })

  it("loads the agent name from IDENTITY.md into the identity block", async () => {
    await writeFile(
      getIdentityPath(),
      "# IDENTITY.md\n\n- **Name:** Pam\n- **Vibe:** Calm and warm.\n",
      "utf-8",
    )
    const instructions = buildInstructions(makeConfig({ provider: "gemini" }))
    expect(instructions).toMatch(/You are Pam/)
  })

  it("loads SOUL.md into the identity block unconditionally", async () => {
    await writeFile(
      getSoulPath(),
      "# SOUL.md\n\n## Core Truths\n\nMARKER-CORE-TRUTH\n",
      "utf-8",
    )
    const instructions = buildInstructions(makeConfig({ provider: "gemini" }))
    expect(instructions).toMatch(/MARKER-CORE-TRUTH/)
  })

  it("preloads FACTS.md inside the workspace context section", async () => {
    await writeFile(
      getFactsPath(),
      "# Facts\n\n- Lives in Toronto.\n- Loves cycling.\n",
      "utf-8",
    )
    const instructions = buildInstructions(makeConfig())
    expect(instructions).toMatch(/Known facts \(FACTS\.md\)/)
    expect(instructions).toMatch(/Lives in Toronto/)
    expect(instructions).toMatch(/Loves cycling/)
  })

  it("preloads recent memory files and excludes anything older than 7 days", async () => {
    await writeFile(getAgentsMdPath(), "MY-AGENTS-MARKER\n", "utf-8")
    const today = new Date()
    const ymd = (d: Date) => {
      const y = d.getFullYear().toString().padStart(4, "0")
      const m = (d.getMonth() + 1).toString().padStart(2, "0")
      const day = d.getDate().toString().padStart(2, "0")
      return `${y}-${m}-${day}`
    }
    const writeMemory = async (offsetDays: number, body: string) => {
      const d = new Date(today.getTime())
      d.setDate(d.getDate() - offsetDays)
      await mkdir(getMemoryDir(), { recursive: true })
      await writeFile(join(getMemoryDir(), `${ymd(d)}.md`), body, "utf-8")
    }
    await writeMemory(0, "TODAY-NOTE")
    await writeMemory(2, "TWO-DAYS-NOTE")
    await writeMemory(10, "TEN-DAYS-NOTE")

    const instructions = buildInstructions(makeConfig())
    expect(instructions).toMatch(/Workspace context \(preloaded\)/)
    expect(instructions).toMatch(/MY-AGENTS-MARKER/)
    expect(instructions).toMatch(/TODAY-NOTE/)
    expect(instructions).toMatch(/TWO-DAYS-NOTE/)
    expect(instructions).not.toMatch(/TEN-DAYS-NOTE/)
  })

  it("shows a memory stub when no memory files exist", () => {
    const instructions = buildInstructions(makeConfig())
    expect(instructions).toMatch(/No memory files yet/)
  })

  it("falls back to the default AGENTS.md if the file is somehow missing", async () => {
    await rm(getAgentsMdPath(), { force: true })
    const instructions = buildInstructions(makeConfig())
    expect(instructions).toMatch(/Voiceclaw Agent Workspace/)
    expect(instructions).toMatch(/~\/\.voiceclaw\/workspace/)
    void getWorkspaceRoot
  })

  it("produces stable output across repeated calls with the same workspace state", () => {
    const a = buildInstructions(makeConfig())
    const b = buildInstructions(makeConfig())
    expect(a).toBe(b)
  })
})
