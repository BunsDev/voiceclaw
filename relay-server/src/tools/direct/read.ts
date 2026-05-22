// `read` direct tool — line-numbered file reads, anywhere on the machine.
//
// Mirrors pi-mono / Claude Code's Read tool semantics so the realtime model's
// prior training transfers: 1-indexed offset, default limit of 2000 lines,
// line-number + tab prefix, per-line and total caps.

import { promises as fs } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { getWorkspaceRoot } from "../../workspace.js"

export const READ_TOOL_NAME = "read"

// Match Claude Code / pi-mono description style so the realtime model maps
// "read package.json" → this tool from training prior.
export const READ_TOOL_DESCRIPTION = `Reads a file from the filesystem. Allowed anywhere — not restricted to the workspace.

- The path argument must be an absolute path, or relative to the voiceclaw workspace root.
- Output is line-numbered: each line is prefixed with its 1-indexed line number and a tab.
- By default, reads up to 2000 lines starting from the beginning of the file. Lines longer than 2000 characters are truncated.
- Use offset and limit when you need to read a specific section of a large file. offset is 1-indexed.
- Total output is capped at 100KB; the tail is truncated with a "(... truncated)" marker.
- Returns "(empty file)" for zero-byte files so the model knows the read succeeded.`

export const READ_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Absolute filesystem path, or path relative to the voiceclaw workspace root.",
    },
    offset: {
      type: "integer",
      description: "1-indexed line number to start reading from. Defaults to 1.",
      minimum: 1,
    },
    limit: {
      type: "integer",
      description: "Maximum number of lines to return. Defaults to 2000.",
      minimum: 1,
    },
  },
  required: ["path"],
} as const

const DEFAULT_LIMIT = 2000
const MAX_LINE_CHARS = 2000
const MAX_OUTPUT_BYTES = 100 * 1024

export interface ReadArgs {
  path: string
  offset?: number
  limit?: number
}

export interface ReadResult {
  content: string
  truncated?: boolean
  totalLines?: number
  bytesReturned: number
}

export interface ReadError {
  error: string
}

export async function runRead(args: ReadArgs): Promise<ReadResult | ReadError> {
  const rawPath = args.path
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { error: "path is required" }
  }

  const absPath = isAbsolute(rawPath) ? rawPath : resolve(getWorkspaceRoot(), rawPath)

  let raw: string
  try {
    raw = await fs.readFile(absPath, "utf-8")
  } catch (err) {
    return { error: `read failed: ${(err as Error).message}` }
  }

  if (raw.length === 0) {
    return { content: "(empty file)", bytesReturned: "(empty file)".length }
  }

  const lines = raw.split("\n")
  // split("\n") on a trailing newline produces a trailing empty entry — drop it
  // so line counts match what the user expects.
  if (lines[lines.length - 1] === "") lines.pop()
  const totalLines = lines.length

  const offset = Math.max(1, Math.floor(args.offset ?? 1))
  const limit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT))
  const start = offset - 1
  const end = Math.min(totalLines, start + limit)

  if (start >= totalLines) {
    return {
      content: `(offset ${offset} is past end of file; file has ${totalLines} line${totalLines === 1 ? "" : "s"})`,
      bytesReturned: 0,
      totalLines,
    }
  }

  const slice = lines.slice(start, end)

  let out = ""
  let truncated = end < totalLines
  let bytesReturned = 0
  for (let i = 0; i < slice.length; i++) {
    const lineNumber = offset + i
    const original = slice[i]
    const lineText = original.length > MAX_LINE_CHARS
      ? `${original.slice(0, MAX_LINE_CHARS)}… (line truncated, ${original.length - MAX_LINE_CHARS} chars omitted)`
      : original
    const formatted = `${lineNumber}\t${lineText}\n`
    if (bytesReturned + formatted.length > MAX_OUTPUT_BYTES) {
      truncated = true
      break
    }
    out += formatted
    bytesReturned += formatted.length
  }

  if (truncated) {
    out += "(... truncated)\n"
  }

  return { content: out, truncated, totalLines, bytesReturned }
}
