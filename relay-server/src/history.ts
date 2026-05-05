// Conversation-history split + summarization for voice session resume.
//
// Voice sessions restart frequently (rotation, cold-start, network drops). To
// preserve continuity without blowing the context window, we keep the last N
// turns verbatim and summarize anything older into a short preamble. The
// preamble is cheap to inject (system text) and the verbatim turns let the
// model match phrasing/style from the immediate prior context.
//
// N=8 turns (16 messages: 8 user + 8 assistant) balances continuity against
// per-turn injection cost. Voice turns are short (~100-200 tokens each), so
// 16 messages ≈ 2-4k tokens — well under OpenAI Realtime's 128k window and
// negligible against Gemini Live's 1M window. Doubling N would not improve
// continuity meaningfully (older turns rarely surface) but would double the
// per-event count we replay on every resume, which adds setup latency.

import type { SessionConfigEvent } from "./types.js"
import { log, error as logError } from "./log.js"

export const RECENT_TURNS_VERBATIM = 8

export type HistoryMessage = {
  role: "user" | "assistant"
  text: string
  timestamp?: number
  relativeMs?: number
}

export interface HistorySplit {
  recent: HistoryMessage[]
  summary: string | null
}

export async function buildHistorySplit(
  history: HistoryMessage[] | undefined,
  provider: SessionConfigEvent["provider"],
): Promise<HistorySplit> {
  if (!history || history.length === 0) {
    return { recent: [], summary: null }
  }

  const recentMessageCount = RECENT_TURNS_VERBATIM * 2
  if (history.length <= recentMessageCount) {
    return { recent: [...history], summary: null }
  }

  const older = history.slice(0, history.length - recentMessageCount)
  const recent = history.slice(history.length - recentMessageCount)
  const summary = await summarize(older, provider)
  return { recent, summary }
}

export function formatSummaryPreamble(summary: string): string {
  return `## Earlier in this conversation\n${summary.trim()}`
}

export function formatStampedTurnText(m: HistoryMessage): string {
  const stamp = formatRelativeStamp(deriveRelativeMs(m))
  return stamp ? `${stamp} ${m.text}` : m.text
}

export function formatRecentTurnsPreamble(recent: HistoryMessage[]): string {
  const lines = recent
    .map((m) => {
      const text = typeof m.text === "string" ? m.text.trim() : ""
      if (!text) return null
      const speaker = m.role === "assistant" ? "Assistant" : "User"
      const stamp = formatRelativeStamp(deriveRelativeMs(m))
      return stamp ? `${stamp} ${speaker}: ${text}` : `${speaker}: ${text}`
    })
    .filter((l): l is string => l !== null)
  if (lines.length === 0) return ""
  return [
    "## Most recent turns (verbatim)",
    "Treat these as already-spoken context. Do not re-greet or restate them; pick up naturally where the conversation left off.",
    "Each turn is prefixed with how long ago it occurred relative to now, e.g. \"[3m ago]\". Use these stamps to answer questions like \"what did we talk about 5 minutes ago?\".",
    "",
    ...lines,
  ].join("\n")
}

// --- helpers ---

const SUMMARY_PROMPT = [
  "You are summarizing the older portion of an ongoing voice conversation so a new",
  "voice session can resume with continuity. Output a tight bullet list of the key",
  "facts, decisions, and action items the assistant should remember. Keep it under",
  "200 tokens. No preamble. No closing remarks. Use this format:",
  "- <fact or decision>",
  "- <fact or decision>",
].join(" ")

const GEMINI_SUMMARY_MODEL = "gemini-2.5-flash"
const XAI_SUMMARY_MODEL = "grok-3-mini"
const SUMMARY_TIMEOUT_MS = 8_000

async function summarize(
  older: HistoryMessage[],
  provider: SessionConfigEvent["provider"],
): Promise<string | null> {
  const transcript = older
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n")

  const order: Summarizer[] = provider === "xai"
    ? [summarizeWithXai]
    : [summarizeWithGemini]

  for (const fn of order) {
    try {
      const summary = await fn(transcript)
      if (summary) return summary
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`[history] ${fn.name} failed (${msg}) — trying next fallback`)
    }
  }

  log("[history] No summarizer produced output — using truncated raw transcript")
  return fallbackTruncatedSummary(older)
}

type Summarizer = (transcript: string) => Promise<string | null>

async function summarizeWithGemini(transcript: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SUMMARY_MODEL}:generateContent?key=${apiKey}`
  const body = {
    systemInstruction: { parts: [{ text: SUMMARY_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: transcript }] }],
    generationConfig: { maxOutputTokens: 400, temperature: 0.2 },
  }

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Gemini summary HTTP ${res.status}`)
  }

  const data = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim()
  return text || null
}

async function summarizeWithXai(transcript: string): Promise<string | null> {
  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) return null

  const url = "https://api.x.ai/v1/chat/completions"
  const body = {
    model: XAI_SUMMARY_MODEL,
    messages: [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: transcript },
    ],
    max_tokens: 400,
    temperature: 0.2,
  }

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`xAI summary HTTP ${res.status}`)
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data.choices?.[0]?.message?.content?.trim()
  return text || null
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function deriveRelativeMs(m: HistoryMessage): number | undefined {
  if (typeof m.relativeMs === "number") return m.relativeMs
  if (typeof m.timestamp === "number") return Math.max(0, Date.now() - m.timestamp)
  return undefined
}

function formatRelativeStamp(relativeMs: number | undefined): string | null {
  if (typeof relativeMs !== "number" || relativeMs < 0) return null
  const sec = Math.floor(relativeMs / 1000)
  if (sec < 60) return `[${sec}s ago]`
  const min = Math.floor(sec / 60)
  if (min < 60) return `[${min}m ago]`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `[${hr}h ago]`
  const day = Math.floor(hr / 24)
  return `[${day}d ago]`
}

function fallbackTruncatedSummary(older: HistoryMessage[]): string {
  const lines = older.map((m) => `- ${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
  const joined = lines.join("\n")
  if (joined.length <= 1500) return joined
  return joined.slice(joined.length - 1500)
}
