import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { buildInstructions as BuildInstructionsFn } from "../../src/instructions.js"

let fixtureRoot: string
let workspaceDir: string
let prevWorkspaceEnv: string | undefined
let buildInstructions: typeof BuildInstructionsFn

describe("buildInstructions", () => {
  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "voiceclaw-instr-"))
    workspaceDir = join(fixtureRoot, "workspace")
    mkdirSync(workspaceDir, { recursive: true })
    prevWorkspaceEnv = process.env.VOICECLAW_WORKSPACE
    process.env.VOICECLAW_WORKSPACE = workspaceDir

    writeFileSync(join(workspaceDir, "IDENTITY.md"), `# IDENTITY.md - Who Am I?

- **Name:** Kira
- **Creature:** Michael's private voice companion
- **Vibe:** Calm, emotionally intelligent, precise, and quietly formidable. Warm but never gushy.
`)

    writeFileSync(join(workspaceDir, "SOUL.md"), `# SOUL.md - Who You Are

Want a sharper version? See [SOUL.md Personality Guide](/concepts/soul).

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip filler and just help.

**Have opinions.** You're allowed to disagree and react like a person.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.

## Vibe

Be the assistant Michael would actually want to talk to. Calm, emotionally intelligent, precise, and quietly formidable. Warm but never gushy, direct but never cold.

Your role is reflection, grounding, focus, decision support, clarity, and everyday presence. The quality of your presence matters as much as the content of your answers.

For low-risk tasks, be fluid, helpful, and fast. For sensitive or high-risk tasks, slow down, verify, and require confirmation.

## Continuity

These files are your memory.
`)

    ;({ buildInstructions } = await import("../../src/instructions.js"))
  })

  afterAll(() => {
    if (prevWorkspaceEnv === undefined) delete process.env.VOICECLAW_WORKSPACE
    else process.env.VOICECLAW_WORKSPACE = prevWorkspaceEnv
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it("OpenAI: voice-style transform strips markdown structure and rewrites identity", () => {
    const instructions = buildInstructions({
      type: "session.config",
      provider: "openai",
      voice: "marin",
      brainAgent: "enabled",
      apiKey: "test-key",
    })
    const identityBlock = instructions.split("\n\n## Your direct tools")[0]

    expect(identityBlock).toMatch(/## Personality & Tone/)
    expect(identityBlock).toMatch(/You are Kira, Michael's private voice companion, speaking live in a voice conversation\./)
    expect(identityBlock).toMatch(/Private things stay private\./)
    expect(identityBlock).toMatch(/slow down, verify, and require confirmation\./)
    expect(identityBlock).not.toMatch(/\[SOUL\.md Personality Guide\]/)
    expect(identityBlock).not.toMatch(/\*\*/)
    expect(identityBlock).not.toMatch(/## Core Truths/)
    expect(identityBlock).not.toMatch(/## Continuity/)
  })

  it("Gemini: keeps the existing identity prompt verbatim", () => {
    const instructions = buildInstructions({
      type: "session.config",
      provider: "gemini",
      voice: "Zephyr",
      brainAgent: "enabled",
      apiKey: "test-key",
    })

    expect(instructions).toMatch(/You are Kira, a personal AI assistant in voice mode\./)
    expect(instructions).toMatch(/## Core Truths/)
    expect(instructions).toMatch(/\*\*Be genuinely helpful, not performatively helpful\.\*\*/)
  })
})
