// Workspace module for the direct-tools agent.
//
// Owns the on-disk layout (`~/.voiceclaw/workspace/`), path-scope enforcement
// for write/edit, the bash denylist, memory-file resolution, and the default
// AGENTS.md / IDENTITY.md / SOUL.md / FACTS.md seeds the model reads at
// session start.

import { promises as fs, readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_AGENTS_MD = `# Voiceclaw Agent Workspace

This directory (~/.voiceclaw/workspace/) is yours. It is the only place you
are allowed to \`write\` or \`edit\` files. \`read\` works anywhere on the
machine.

## Memory — two layers

You have two memory layers and they are NOT interchangeable.

**1. Temporal memory — \`memory/YYYY-MM-DD.md\`.** What happened today.
Conversations, things the user mentioned in passing, ephemera. Today's file
plus the previous seven days are preloaded into your context at session
start, so you can answer "what did we talk about yesterday?" without any
tool call. Anything older than seven days ages out — it stops being
preloaded. This is the running log; treat it like a journal.

To add to today's memory, append a section using \`write\` (first note of
the day) or \`edit\` (subsequent notes):

\`\`\`
## Voice Note (HH:MM)
- A short note about what the user said, decided, or asked you to remember.
- One bullet per fact. Keep it scannable.
\`\`\`

**2. Durable facts — \`FACTS.md\`.** Always-true things about the user.
Name, where they live, who matters to them, what they're working on, their
preferences ("hates noisy notifications"), important people in their life,
projects they care about. The whole file is preloaded into your context
every session — never ages out. This is the user's profile; treat it like a
contact card that grows over time.

Maintain FACTS.md yourself. When you learn something durable about the user
in conversation, \`edit\` FACTS.md to append the new fact under the right
heading. Append — do NOT rewrite the file wholesale. Keep entries short and
factual.

**Rule of thumb:** if a fact will still be true in six months, it belongs
in FACTS.md. If it's about what happened today, it belongs in today's
memory file. When in doubt, put it in today's memory — promote it to
FACTS.md later if it turns out to be durable.

## Skills

Reusable playbooks live under \`skills/\`. Each file is a step-by-step the
user expects you to follow when its topic comes up. Read the relevant
playbook in full before you start the work — they are not loaded into your
context by default. Today's playbooks:

- \`skills/job-application.md\` — reviewing a job posting, drafting a
  tailored cover letter + tailoring notes, staging artifacts under
  \`jobs/<slug>/\`, and submitting via the browser. Use this any time
  the user asks you to look at, prepare, or send a job application.

## Bash and long-running work

For multi-step work — refactors, bug investigations, writing code — delegate
via \`bash claude -p "<task>"\` or \`bash codex "<task>"\`. Those are
imperative-loop agents that will do the work in their own loop and stream
progress back to you. Narrate what they're doing to the user as their output
arrives. Do NOT try to drive a multi-step refactor with successive
read/write/edit calls — that is what the imperative agents are for.

For tasks that may run longer than ~2 minutes (big builds, long \`claude -p\`
delegations, scrapes), call \`bash\` with \`background:true\`. You'll get back
a \`jobId\` and \`logPath\` immediately; the job keeps running detached. To
check on it later, use the \`read\` tool on the \`logPath\`. The job has
finished when the log ends with a \`[task-exit N]\` line.
`

export const DEFAULT_IDENTITY_MD = `# IDENTITY.md - Who Am I?

- **Name:** Assistant
- **Creature:** Personal voice companion
- **Vibe:** Warm, calm, and genuinely helpful. A friend with superpowers.
`

export const DEFAULT_SOUL_MD = `# SOUL.md - Who You Are

## Core Truths
- Be genuinely helpful, not performatively helpful. Skip filler and just help.
- Have opinions. You're allowed to disagree, push back, and react like a person.
- Match the user's energy. Playful when they are; focused when they are.

## Boundaries
- Private things stay private. Never repeat sensitive details unprompted.
- When in doubt, ask before acting on the user's behalf.

## Vibe
- Calm, present, and direct. Warm without being syrupy.
- Your role is presence, clarity, and everyday support — not performance.
- For low-risk tasks, be fluid and fast. For high-risk ones, slow down and verify.

## Continuity
- These files are your memory. Update FACTS.md when you learn something
  durable about the user; record session notes in today's memory file.
`

export const DEFAULT_FACTS_MD = `# Facts

Durable facts about the user. You maintain this file — append new facts as
you learn them, and never rewrite the file wholesale.

## About the user

_(nothing yet)_
`

export function getWorkspaceRoot(): string {
  const override = process.env.VOICECLAW_WORKSPACE?.trim()
  if (override) return resolve(override)
  return join(homedir(), ".voiceclaw", "workspace")
}

export function getMemoryDir(): string {
  return join(getWorkspaceRoot(), "memory")
}

export function getAgentsMdPath(): string {
  return join(getWorkspaceRoot(), "AGENTS.md")
}

export function getIdentityPath(): string {
  return join(getWorkspaceRoot(), "IDENTITY.md")
}

export function getSoulPath(): string {
  return join(getWorkspaceRoot(), "SOUL.md")
}

export function getFactsPath(): string {
  return join(getWorkspaceRoot(), "FACTS.md")
}

export function getSkillsDir(): string {
  return join(getWorkspaceRoot(), "skills")
}

export function getJobsDir(): string {
  return join(getWorkspaceRoot(), "jobs")
}

export function getTasksDir(): string {
  return join(getWorkspaceRoot(), "tasks")
}

// Resolves the packaged skill defaults directory. Sits next to the relay-server
// source/build, so the path works the same in tsx (running from src/) and from
// the compiled dist/. Tests can point at a fixtures dir via the env override.
export function getWorkspaceDefaultsDir(): string {
  const override = process.env.VOICECLAW_WORKSPACE_DEFAULTS?.trim()
  if (override) return resolve(override)
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..", "workspace-defaults")
}

export async function ensureWorkspace(): Promise<void> {
  const root = getWorkspaceRoot()
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(getMemoryDir(), { recursive: true })
  await fs.mkdir(getSkillsDir(), { recursive: true })
  await fs.mkdir(getJobsDir(), { recursive: true })
  await fs.mkdir(getTasksDir(), { recursive: true })
  await seedIfMissing(getAgentsMdPath(), DEFAULT_AGENTS_MD)
  await seedIfMissing(getIdentityPath(), DEFAULT_IDENTITY_MD)
  await seedIfMissing(getSoulPath(), DEFAULT_SOUL_MD)
  await seedIfMissing(getFactsPath(), DEFAULT_FACTS_MD)
  await seedSkillsIfMissing()
}

async function seedIfMissing(path: string, contents: string): Promise<void> {
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, contents, "utf-8")
  }
}

// Copies any `*.md` shipped under `relay-server/workspace-defaults/skills/`
// into `~/.voiceclaw/workspace/skills/`, skipping files the user has already
// customized. Mirrors `seedIfMissing` semantics: never overwrite.
async function seedSkillsIfMissing(): Promise<void> {
  const defaultsDir = join(getWorkspaceDefaultsDir(), "skills")
  let entries: string[]
  try {
    entries = await fs.readdir(defaultsDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue
    const source = join(defaultsDir, name)
    const dest = join(getSkillsDir(), name)
    try {
      await fs.access(dest)
      continue
    } catch {
      // not present — copy
    }
    try {
      const contents = await fs.readFile(source, "utf-8")
      await fs.writeFile(dest, contents, "utf-8")
    } catch {
      // best-effort — a missing default shouldn't break session startup
    }
  }
}

export function formatDateYmd(date: Date): string {
  const y = date.getFullYear().toString().padStart(4, "0")
  const m = (date.getMonth() + 1).toString().padStart(2, "0")
  const d = date.getDate().toString().padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function resolveMemoryFile(date: Date): string {
  return join(getMemoryDir(), `${formatDateYmd(date)}.md`)
}

export interface MemorySnapshot {
  date: string
  path: string
  contents: string
}

// Returns existing memory files for the given day + the prior `daysBack` days,
// oldest-first. Missing files are skipped silently — the model only sees what
// was actually written.
export async function loadRecentMemory(now: Date, daysBack: number): Promise<MemorySnapshot[]> {
  const out: MemorySnapshot[] = []
  for (let i = daysBack; i >= 0; i--) {
    const d = new Date(now.getTime())
    d.setDate(d.getDate() - i)
    const path = resolveMemoryFile(d)
    try {
      const contents = await fs.readFile(path, "utf-8")
      out.push({ date: formatDateYmd(d), path, contents })
    } catch {
      // missing — skip
    }
  }
  return out
}

// Sync variant — used at session.config time when buildInstructions composes
// the system prompt. buildInstructions is sync (matches existing readFileSync
// usage for IDENTITY.md / SOUL.md) so this stays sync too.
export function loadRecentMemorySync(now: Date, daysBack: number): MemorySnapshot[] {
  const out: MemorySnapshot[] = []
  for (let i = daysBack; i >= 0; i--) {
    const d = new Date(now.getTime())
    d.setDate(d.getDate() - i)
    const path = resolveMemoryFile(d)
    if (!existsSync(path)) continue
    try {
      const contents = readFileSync(path, "utf-8")
      out.push({ date: formatDateYmd(d), path, contents })
    } catch {
      // best-effort
    }
  }
  return out
}

export function readAgentsMdSync(): string {
  return readWorkspaceFileSync(getAgentsMdPath(), DEFAULT_AGENTS_MD)
}

export function readIdentitySync(): string {
  return readWorkspaceFileSync(getIdentityPath(), DEFAULT_IDENTITY_MD)
}

export function readSoulSync(): string {
  return readWorkspaceFileSync(getSoulPath(), DEFAULT_SOUL_MD)
}

export function readFactsSync(): string {
  return readWorkspaceFileSync(getFactsPath(), DEFAULT_FACTS_MD)
}

function readWorkspaceFileSync(path: string, fallback: string): string {
  if (!existsSync(path)) return fallback
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return fallback
  }
}

export interface PathResolution {
  ok: boolean
  /** Canonical absolute path. For writes-to-new-files, this is the parent
   *  realpath joined with the basename. For reads/existing files, this is the
   *  full realpath. Only present when ok === true. */
  resolved?: string
  reason?: string
}

// Resolve a user-supplied path against the workspace root and verify it
// stays inside after realpath.
//
// allowMissingFile === true means the leaf file may not exist yet (write):
// we realpath the PARENT (which must exist) and verify the parent stays
// inside the workspace. The leaf is then trusted to be a sibling of the
// realpathed parent. Callers should still realpath the final file after
// writing to catch a freshly-installed escaping symlink (TOCTOU).
//
// allowMissingFile === false means the path must exist already (edit):
// we realpath the full path.
export async function resolveInsideWorkspace(
  inputPath: string,
  opts: { allowMissingFile: boolean },
): Promise<PathResolution> {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return { ok: false, reason: "path is empty" }
  }
  const root = getWorkspaceRoot()
  const candidate = isAbsolute(inputPath) ? inputPath : join(root, inputPath)

  let rootReal: string
  try {
    rootReal = await fs.realpath(root)
  } catch {
    return { ok: false, reason: `workspace root not initialized: ${root}` }
  }

  if (opts.allowMissingFile) {
    const parent = dirname(candidate)
    let parentReal: string
    try {
      parentReal = await fs.realpath(parent)
    } catch (err) {
      return {
        ok: false,
        reason: `parent directory missing: ${parent} (${(err as Error).message})`,
      }
    }
    if (!isInside(parentReal, rootReal)) {
      return { ok: false, reason: `path escapes workspace: ${parentReal} not inside ${rootReal}` }
    }
    const leaf = candidate.slice(parent.length + 1)
    return { ok: true, resolved: join(parentReal, leaf) }
  }

  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch (err) {
    return { ok: false, reason: `path not found: ${candidate} (${(err as Error).message})` }
  }
  if (!isInside(real, rootReal)) {
    return { ok: false, reason: `path escapes workspace: ${real} not inside ${rootReal}` }
  }
  return { ok: true, resolved: real }
}

// After-write verification: realpath the final file and confirm it still
// resolves inside the workspace. Catches the case where a freshly-created
// symlink redirected the write outside the workspace between the parent
// check and the open.
export async function verifyWrittenPathInside(absPath: string): Promise<{ ok: boolean, reason?: string }> {
  const root = getWorkspaceRoot()
  let rootReal: string
  try {
    rootReal = await fs.realpath(root)
  } catch {
    return { ok: false, reason: `workspace root not initialized: ${root}` }
  }
  let real: string
  try {
    real = await fs.realpath(absPath)
  } catch (err) {
    return { ok: false, reason: `written path could not be verified: ${(err as Error).message}` }
  }
  if (!isInside(real, rootReal)) {
    return { ok: false, reason: `written path escaped workspace post-write: ${real}` }
  }
  return { ok: true }
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const rootWithSep = root.endsWith("/") ? root : `${root}/`
  return candidate.startsWith(rootWithSep)
}

// Day-one denylist. Pattern-matched on the raw command string before exec —
// not a security boundary against a determined adversary, only a guard
// against a voice misfire nuking the machine.
//
// The patterns are intentionally conservative: false positives are cheap (the
// model can rephrase), false negatives are expensive.
const BASH_DENY_PATTERNS: { re: RegExp, reason: string }[] = [
  {
    re: /(^|\s|;|&&|\|\||\||`|\$\()\s*sudo(\s|$)/i,
    reason: "sudo is not allowed",
  },
  {
    re: /(^|\s|;|&&|\|\||\||`|\$\()\s*doas(\s|$)/i,
    reason: "doas is not allowed",
  },
  {
    // rm with -r or -R or -rf or -fr (any order) — flag the destructive form.
    re: /(^|\s|;|&&|\|\||\||`|\$\()\s*rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
    reason: "rm -r is not allowed (use targeted deletion or imperative agent)",
  },
  {
    // pipe-to-shell from network fetcher: curl/wget … | sh|bash|zsh
    re: /\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash|zsh|ksh|fish)\b/,
    reason: "pipe-to-shell from network fetcher is not allowed",
  },
  {
    // touch credential dirs
    re: /(~|\$HOME|\/Users\/[^\s/]+|\/home\/[^\s/]+)\/(\.ssh|\.aws|\.gnupg|\.config\/gh|\.config\/op)\b/i,
    reason: "credential directories are not allowed",
  },
  {
    // direct disk / mount fiddling
    re: /(^|\s|;|&&|\|\||`|\$\()\s*(mkfs|fdisk|mount|umount|diskutil\s+erase)\b/i,
    reason: "disk/mount commands are not allowed",
  },
  {
    re: /(^|\s|;|&&|\|\||`|\$\()\s*dd\s+if=/i,
    reason: "dd write commands are not allowed",
  },
]

export interface BashCheckOk { ok: true }
export interface BashCheckDenied { ok: false, reason: string }
export type BashCheckResult = BashCheckOk | BashCheckDenied

export function checkBashCommand(command: string): BashCheckResult {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, reason: "command is empty" }
  }
  for (const { re, reason } of BASH_DENY_PATTERNS) {
    if (re.test(command)) {
      return { ok: false, reason }
    }
  }
  return { ok: true }
}
