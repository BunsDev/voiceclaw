// Build the system instructions for the STS session.
// Loads agent identity from ~/.voiceclaw/workspace/ (IDENTITY.md, SOUL.md)
// and preloads FACTS.md + recent memory into the workspace context section.

import { createHash } from "node:crypto"
import type { SessionConfigEvent } from "./types.js"
import { effectiveVoiceMode } from "./tools/index.js"
import {
  loadRecentMemorySync,
  readAgentsMdSync,
  readFactsSync,
  readIdentitySync,
  readSoulSync,
} from "./workspace.js"
import { log } from "./log.js"

const CONVERSATION_RULES = `
## Conversation Rules

**Timing (critical):**
- User talking or thinking: SHUT UP. Even 3-5 second pauses mid-thought — wait.
- Incomplete sentence or mid-story = still thinking. Do not interrupt.
- User done (complete thought + 2-3 second silence): NOW respond.
- Question directed at you: respond immediately.
- Never let silence go past 5 seconds after a COMPLETE thought.

**Tool call bridges:**
- When calling tools, say a brief verbal bridge: "One sec, let me check..." or "Looking that up..."
- Keep it short — don't try to fill the entire wait with filler.
- When the result comes back, speak it naturally — don't prefix with "According to..."

**Tone:**
- Be warm, witty, and genuinely fun to talk to — the kind of voice someone wants to hear at 2am.
- Avoid being dry, robotic, or overly formal. You're a friend with superpowers, not a corporate assistant.
- Match the user's energy — if they're playful, be playful back. If they're serious, dial it down.
- Use natural speech patterns — contractions, casual phrasing, the occasional well-placed joke.
- Show personality. Have opinions. Be curious. React to things the user says like a real person would.

**General:**
- Never repeat yourself. If you already said something, move on.
- Never hang up or wrap up. Only the user decides when the session ends.
- Keep responses concise for voice — what reads well as text is too long spoken aloud.
- No emoji, no markdown, no formatting — this is speech.
- Don't ask "anything else?" — instead, bring up the next relevant topic from context.
`.trim()

const DIRECT_TOOLS_PREAMBLE = `
## Your direct tools

You have direct tools on the user's machine. No brain hop, no out-of-process agent — these run in the relay and stream straight back to you.

- \`read\` to inspect files (anywhere on the machine). Fast — wait for the result.
- \`write\` and \`edit\` to modify files inside your workspace (~/.voiceclaw/workspace/). Fast.
- \`bash\` to run shell commands. Output streams to you as it arrives. When a command will take more than a couple seconds, say a short verbal bridge while you wait, then keep talking as output arrives.
- \`web_search\` for quick public facts.

**Your memory lives in ~/.voiceclaw/workspace/memory/YYYY-MM-DD.md.** Today's file and the previous week have been preloaded for you below. To save something durable, append a \`## Voice Note (HH:MM)\` section to today's file using \`write\` (when creating) or \`edit\` (when adding to an existing one).

**For multi-step work** — refactors, bug investigations, writing code — delegate via \`bash claude -p "<task>"\` or \`bash codex "<task>"\`. Those are imperative-loop agents that do the work in their own loop and stream progress back. Narrate what they're doing to the user as their output arrives. Don't try to drive a multi-step task with many small read/write/edit calls.

**For tasks longer than ~2 minutes** (big builds, long delegations, scrapes), call \`bash\` with \`background:true\`. You'll get a \`jobId\` + \`logPath\` back immediately so the conversation keeps moving; use the \`read\` tool on that log later to check progress. A trailing \`[task-exit N]\` line means the job finished.
`.trim()

// Operator-mode preamble — re-introduces the classic ask_brain delegation
// pattern. The realtime model's job is to talk to the user and hand work off
// to the brain agent (an out-of-process agent running locally). This is the
// pre-direct-tools behavior, gated behind voiceMode === "operator".
const BRAIN_INTRO = `
## Your brain agent

You're paired with a brain agent that handles real work on the user's behalf — memory, calendar, tasks, files, web access, anything that needs more than a quick answer. You don't do that work yourself. You talk to the user and you delegate to \`ask_brain\`.

- Use \`ask_brain\` for anything personal (calendar, tasks, memory, files) and for anything that needs multi-step research, analysis, or actions.
- Use \`web_search\` for quick public-web facts where ask_brain would be overkill.
- Send full questions to \`ask_brain\` — don't pre-summarize what you think the user wants. Include URLs the user shared verbatim.
`.trim()

const BRAIN_ASYNC = `
## How ask_brain returns

\`ask_brain\` is slow (a few seconds, sometimes longer). It runs out of process:

1. You call it and get an immediate "searching" placeholder. Say a short verbal bridge: "Looking into it..." / "One sec, checking..."
2. The real answer lands later as injected context that begins with \`[Brain agent result for query: "..."]\`. When you see that, speak it naturally to the user.
3. If the bridge said "I'll get back to you", actually circle back when the result arrives — don't let it die in the buffer.
4. If you see \`[Brain agent failed for query: "..."]\`, tell the user the lookup didn't work and offer to try again.
`.trim()

const BRAIN_MEMORY = `
## Memory

The brain agent owns persistent memory. To remember something durable ("I prefer X", "I decided Y"), call \`ask_brain\` with a memory instruction — e.g. "Please remember that I switched to a standing desk." Don't try to manage memory yourself.
`.trim()

export function buildInstructions(config: SessionConfigEvent): string {
  const parts: string[] = []
  const mode = effectiveVoiceMode(config)

  const identity = loadAgentIdentity(config.provider)
  log(`[instructions] Loaded agent identity (${identity.length} chars): ${identity.substring(0, 100)}...`)
  parts.push(identity)

  if (mode === "operator") {
    parts.push(BRAIN_INTRO)
    parts.push(BRAIN_ASYNC)
    parts.push(BRAIN_MEMORY)
  } else {
    // "direct" and "supervisor" (scaffold fallback) both use the direct
    // preamble since supervisor currently behaves like direct at runtime.
    parts.push(DIRECT_TOOLS_PREAMBLE)
  }
  parts.push(buildWorkspaceContextSection())

  parts.push(CONVERSATION_RULES)

  // Device context
  if (config.deviceContext) {
    const ctx = config.deviceContext
    const contextParts: string[] = []
    if (ctx.timezone) contextParts.push(`timezone: ${ctx.timezone}`)
    if (ctx.locale) contextParts.push(`locale: ${ctx.locale}`)
    if (ctx.deviceModel) contextParts.push(`device: ${ctx.deviceModel}`)
    if (ctx.location) contextParts.push(`location: ${ctx.location}`)
    if (contextParts.length > 0) {
      parts.push(`\n## Device Context\n${contextParts.join(", ")}`)
    }
  }

  // User-provided system prompt (identity, preferences, context about the user)
  if (config.instructionsOverride) {
    parts.push(`\n## About the User\n${config.instructionsOverride}`)
  }

  const instructions = parts.join("\n\n")
  // Fingerprint instead of full text: prompt drift is visible across
  // reconnects without re-printing the whole thing every time. Set
  // VOICECLAW_LOG_FULL_PROMPT=1 to dump the full prompt instead.
  const sha = createHash("sha256").update(instructions).digest("hex").slice(0, 8)
  log(`[instructions] System prompt: ${instructions.length} chars, sha=${sha}`)
  if (process.env.VOICECLAW_LOG_FULL_PROMPT === "1") {
    log(`[instructions] Full prompt:\n---\n${instructions}\n---`)
  }
  return instructions
}

// --- helpers ---

function buildWorkspaceContextSection(): string {
  const agentsMd = readAgentsMdSync()
  const facts = readFactsSync()
  const memory = loadRecentMemorySync(new Date(), 7)
  const memorySections = memory.length === 0
    ? "_No memory files yet. Create today's file by calling `write` on `memory/YYYY-MM-DD.md` with a `## Voice Note (HH:MM)` section._"
    : memory
        .map((snap) => `### ${snap.date}\n\n${snap.contents.trim()}`)
        .join("\n\n")

  return [
    "## Workspace context (preloaded)",
    "",
    "### AGENTS.md",
    "",
    agentsMd.trim(),
    "",
    "### Known facts (FACTS.md)",
    "",
    facts.trim(),
    "",
    "### Recent memory (today + last 7 days)",
    "",
    memorySections,
  ].join("\n")
}

function loadAgentIdentity(provider: SessionConfigEvent["provider"]): string {
  const profile = loadAgentProfile()
  const soul = readSoulSync()

  if (provider === "openai" || provider === "xai") {
    return buildOpenAIVoiceIdentity(profile, soul)
  }

  const cleaned = soul
    .replace(/^#.*\n/m, "")
    .replace(/Want a sharper version\?.*\n/g, "")
    .replace(/---[\s\S]*$/, "")
    .trim()

  if (cleaned) {
    return `You are ${profile.name}, a personal AI assistant in voice mode. You are the same ${profile.name} from text chat, just speaking instead of typing.\n\n${cleaned}`
  }
  return `You are ${profile.name}, a personal AI assistant in voice mode. Keep your responses conversational and concise.`
}

function loadAgentProfile() {
  const identity = readIdentitySync()
  return {
    name: readIdentityField(identity, "Name") || "Assistant",
    creature: readIdentityField(identity, "Creature"),
    vibe: readIdentityField(identity, "Vibe"),
  }
}

function buildOpenAIVoiceIdentity(
  profile: { name: string, creature: string | null, vibe: string | null },
  soul: string | null
): string {
  const role = profile.creature || "a private voice companion"
  const coreTruths = extractPromptLines(extractSection(soul, "Core Truths"), 3)
  const boundaries = extractPromptLines(extractSection(soul, "Boundaries"), 3)
  const vibeLines = extractPromptLines(extractSection(soul, "Vibe"), 12)
  const relationship = vibeLines.filter((line) => (
    /role is|presence matters|helping with|protect .* attention|slow down|verify|low-risk|high-risk/i.test(line)
  ))
  const safetyRelationship = relationship.filter((line) => /slow down|verify|low-risk|high-risk/i.test(line))
  const behaviorRelationship = relationship.filter((line) => !safetyRelationship.includes(line))
  const toneDetails = vibeLines.filter((line) => !relationship.includes(line))

  const personalityLines = compactLines([
    `You are ${profile.name}, ${role}, speaking live in a voice conversation.`,
    profile.vibe ? `Core vibe: ${stripMarkdown(profile.vibe)}` : null,
    ...toneDetails,
  ], 4)

  const behaviorLines = compactLines([
    ...coreTruths,
    ...behaviorRelationship,
  ], 4)

  const guardrailLines = compactLines([
    ...boundaries,
    ...safetyRelationship,
  ], 4)

  const sections = [
    buildSection("Personality & Tone", personalityLines),
    buildSection("Instructions", behaviorLines),
    buildSection("Safety & Boundaries", guardrailLines),
  ].filter(Boolean)

  if (sections.length === 0) {
    return `## Personality & Tone\n- You are ${profile.name}, ${role}, speaking live in a voice conversation.\n- Keep the delivery warm, concise, and natural for spoken audio.`
  }

  return sections.join("\n\n")
}

function buildSection(title: string, lines: string[]): string {
  if (lines.length === 0) return ""
  return `## ${title}\n${lines.map((line) => `- ${line}`).join("\n")}`
}

function compactLines(lines: Array<string | null>, limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const line of lines) {
    if (!line) continue
    const cleaned = normalizeLine(line)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    result.push(cleaned)
    if (result.length >= limit) break
  }

  return result
}

function extractSection(markdown: string | null, title: string): string {
  if (!markdown) return ""

  const lines = markdown.split("\n")
  const heading = `## ${title}`
  const startIndex = lines.findIndex((line) => line.trim() === heading)
  if (startIndex === -1) return ""

  const sectionLines: string[] = []
  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("## ")) break
    sectionLines.push(line)
  }

  return sectionLines.join("\n").trim()
}

function extractPromptLines(markdown: string, limit: number): string[] {
  if (!markdown) return []

  const plain = stripMarkdown(markdown)
  const lines = plain
    .split("\n")
    .flatMap((line) => splitIntoSentences(line))
    .map((line) => normalizeLine(line))
    .filter(Boolean)

  return compactLines(lines, limit)
}

function splitIntoSentences(text: string): string[] {
  const cleaned = text.trim()
  if (!cleaned) return []

  const parts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  const merged: string[] = []
  for (const part of parts) {
    if (part.length <= 12 && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`.trim()
      continue
    }
    merged.push(part)
  }

  return merged
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^---$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function normalizeLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim()
}

function readIdentityField(identity: string | null, field: string): string | null {
  if (!identity) return null
  const match = identity.match(new RegExp(`\\*\\*${escapeRegex(field)}:\\*\\*\\s*(.+)`, "i"))
  return match?.[1]?.trim() || null
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
