// Workspace module for the direct-tools experiment.
//
// Owns the on-disk layout (`~/.voiceclaw/workspace/`), path-scope enforcement
// for write/edit, the bash denylist, memory-file resolution, and the default
// AGENTS.md the model reads at session start.

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export const DEFAULT_AGENTS_MD = `# Voiceclaw Agent Workspace

This directory (~/.voiceclaw/workspace/) is yours. It is the only place you
are allowed to \`write\` or \`edit\` files. \`read\` works anywhere on the
machine.

## Memory

Your persistent memory lives under \`memory/\` as one markdown file per day,
named \`YYYY-MM-DD.md\`. Today's file and the previous seven days are
preloaded into your context at session start, so you can answer "what did we
talk about yesterday?" without any tool call.

To save something durable, append a section to today's memory file using
\`write\` (when creating) or \`edit\` (when updating). Use this format so it
stays consistent with openclaw-style memory files:

\`\`\`
## Voice Note (HH:MM)
- A short note about what the user said, decided, or asked you to remember.
- One bullet per fact. Keep it scannable.
\`\`\`

Save what would actually be useful next session: decisions, facts about the
user, open threads. Do not save trivia or your own chatter.

## Bash and long-running work

For multi-step work — refactors, bug investigations, writing code — delegate
via \`bash claude -p "<task>"\` or \`bash codex "<task>"\`. Those are
imperative-loop agents that will do the work in their own loop and stream
progress back to you. Narrate what they're doing to the user as their output
arrives. Do NOT try to drive a multi-step refactor with successive
read/write/edit calls — that is what the imperative agents are for.
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

export async function ensureWorkspace(): Promise<void> {
  const root = getWorkspaceRoot()
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(getMemoryDir(), { recursive: true })
  const agentsPath = getAgentsMdPath()
  try {
    await fs.access(agentsPath)
  } catch {
    await fs.writeFile(agentsPath, DEFAULT_AGENTS_MD, "utf-8")
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
