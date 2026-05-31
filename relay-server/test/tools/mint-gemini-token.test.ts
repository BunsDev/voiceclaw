import { describe, expect, it, vi } from "vitest"
import { mintGeminiToken } from "../../src/tools/mint-gemini-token.js"

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  })
}

describe("mintGeminiToken", () => {
  it("returns ephemeral=true with the token name from the auth_tokens API", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        name: "auth_token_v1__abc123",
        expireTime: "2099-01-01T00:00:00Z",
      }),
    ) as unknown as typeof fetch

    const result = await mintGeminiToken({
      apiKey: "test-key",
      model: "gemini-3.1-flash-live-preview",
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok result")
    expect(result.token).toBe("auth_token_v1__abc123")
    expect(result.ephemeral).toBe(true)
    expect(result.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"))
    expect(result.warning).toBeUndefined()
  })

  it("posts to the auth_tokens endpoint with key in query and proper JSON body", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ name: "tok" }),
    ) as unknown as typeof fetch

    await mintGeminiToken({
      apiKey: "secret&key=evil",
      model: "gemini-3.1-flash-live-preview",
      fetchImpl,
      endpoint: "https://example.test/v1alpha/auth_tokens",
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    // API key escaped into query
    expect(url).toBe(`https://example.test/v1alpha/auth_tokens?key=${encodeURIComponent("secret&key=evil")}`)
    expect(init?.method).toBe("POST")
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json")
    const body = JSON.parse(String(init?.body))
    expect(body.uses).toBe(1)
    expect(typeof body.expireTime).toBe("string")
    expect(typeof body.newSessionExpireTime).toBe("string")
    expect(body.liveConnectConstraints).toEqual({ model: "gemini-3.1-flash-live-preview" })
  })

  it("fails closed (no raw-key fallback) when the upstream returns non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch

    const result = await mintGeminiToken({ apiKey: "raw-key", fetchImpl })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toMatch(/403/)
    // Critically: the raw key must never appear in the failure payload.
    expect(result.error).not.toContain("raw-key")
  })

  it("fails closed when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch

    const result = await mintGeminiToken({ apiKey: "raw-key", fetchImpl })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toMatch(/ECONNREFUSED/)
    expect(result.error).not.toContain("raw-key")
  })

  it("fails closed when the upstream response is missing a name", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch

    const result = await mintGeminiToken({ apiKey: "raw-key", fetchImpl })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toMatch(/missing token name/)
    expect(result.error).not.toContain("raw-key")
  })

  it("rejects when the API key is empty", async () => {
    const result = await mintGeminiToken({ apiKey: "" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.error).toMatch(/GEMINI_API_KEY/)
  })

  it("omits liveConnectConstraints when no model is passed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "tok" })) as unknown as typeof fetch
    await mintGeminiToken({ apiKey: "k", fetchImpl })
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect("liveConnectConstraints" in body).toBe(false)
  })
})
