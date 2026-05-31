// Mint a short-lived auth token for Gemini Live (`BidiGenerateContent`).
//
// Uses the GenerativeLanguage `auth_tokens` API at v1alpha. The token returned
// by the API can be passed as `?key=<token>` when opening the Live WebSocket,
// which is what the mobile "direct to provider" path needs so we never ship
// the long-lived GEMINI_API_KEY off the desktop.
//
// Failure is fail-closed: if the upstream call fails (4xx, 5xx, parse, missing
// name), we return an error so the mobile client falls back to relay-proxy
// mode instead of receiving the raw long-lived key.

export const GEMINI_AUTH_TOKEN_URL =
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"

// 30 minutes of validity (the API caps somewhere around there). The token can
// only START a new session in the first NEW_SESSION_WINDOW_MS — once a session
// has been opened it can keep going for the full EXPIRE_MS.
const EXPIRE_MS = 30 * 60 * 1000
const NEW_SESSION_WINDOW_MS = 2 * 60 * 1000

export interface MintGeminiTokenOptions {
  apiKey: string
  model?: string
  // Hook for tests — defaults to global fetch.
  fetchImpl?: typeof fetch
  // Override for tests that don't want to hit the real endpoint.
  endpoint?: string
  now?: () => number
}

export interface MintGeminiTokenSuccess {
  ok: true
  token: string
  expiresAt: number
  ephemeral: true
  warning?: string
}

export interface MintGeminiTokenFailure {
  ok: false
  error: string
}

export type MintGeminiTokenResult = MintGeminiTokenSuccess | MintGeminiTokenFailure

export async function mintGeminiToken(
  opts: MintGeminiTokenOptions,
): Promise<MintGeminiTokenResult> {
  const { apiKey } = opts
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return { ok: false, error: "GEMINI_API_KEY is not set on the relay" }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const endpoint = opts.endpoint ?? GEMINI_AUTH_TOKEN_URL
  const now = (opts.now ?? Date.now)()

  const expireAtMs = now + EXPIRE_MS
  const newSessionExpireAtMs = now + NEW_SESSION_WINDOW_MS

  const body: Record<string, unknown> = {
    uses: 1,
    expireTime: new Date(expireAtMs).toISOString(),
    newSessionExpireTime: new Date(newSessionExpireAtMs).toISOString(),
  }
  if (opts.model) {
    body.liveConnectConstraints = { model: opts.model }
  }

  let response: Response
  try {
    response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, error: `gemini auth_tokens unavailable: network error: ${(err as Error).message}` }
  }

  if (!response.ok) {
    let upstream = ""
    try {
      upstream = await response.text()
    } catch {
      // best-effort — body may not be readable
    }
    return { ok: false, error: `gemini auth_tokens unavailable: upstream returned ${response.status}: ${upstream.slice(0, 200)}` }
  }

  let parsed: { name?: unknown, expireTime?: unknown } | null = null
  try {
    parsed = (await response.json()) as { name?: unknown, expireTime?: unknown }
  } catch (err) {
    return { ok: false, error: `gemini auth_tokens unavailable: upstream returned non-JSON: ${(err as Error).message}` }
  }

  const tokenName = typeof parsed.name === "string" ? parsed.name : ""
  if (!tokenName) {
    return { ok: false, error: "gemini auth_tokens unavailable: upstream response missing token name" }
  }

  const expiresAt = typeof parsed.expireTime === "string"
    ? Date.parse(parsed.expireTime)
    : expireAtMs
  return {
    ok: true,
    token: tokenName,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : expireAtMs,
    ephemeral: true,
  }
}
