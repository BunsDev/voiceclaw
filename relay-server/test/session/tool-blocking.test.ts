import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { context, propagation, trace } from "@opentelemetry/api"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"
import { RelaySession } from "../../src/session.js"
import type { AdapterCapabilities, ProviderAdapter } from "../../src/adapters/types.js"
import { findRelayTool, isBlockingLatencyClass } from "../../src/tools/index.js"
import type { RelayEvent, SessionConfigEvent } from "../../src/types.js"

interface CapturedAdapterCalls {
  sendToolResult: { callId: string, output: string }[]
  injectContext: string[]
}

interface MockServerHandle {
  port: number
  close: () => Promise<void>
}

describe("session tool-call blocking dispatch", () => {
  let httpServer: MockServerHandle | null = null

  beforeAll(() => {
    const provider = new BasicTracerProvider()
    trace.setGlobalTracerProvider(provider)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    const ctxManager = new AsyncHooksContextManager().enable()
    context.setGlobalContextManager(ctxManager)
  })

  afterEach(async () => {
    if (httpServer) {
      await httpServer.close()
      httpServer = null
    }
    delete process.env.BRAIN_GATEWAY_URL
    delete process.env.OPENCLAW_GATEWAY_URL
    delete process.env.TAVILY_ENDPOINT
    delete process.env.TAVILY_API_KEY
  })

  afterAll(() => {
    delete process.env.BRAIN_GATEWAY_URL
    delete process.env.OPENCLAW_GATEWAY_URL
    delete process.env.TAVILY_ENDPOINT
    delete process.env.TAVILY_API_KEY
  })

  it("blocking tool: synchronous result sent via sendToolResult, no placeholder, no injectContext", async () => {
    httpServer = await mountTavilyMock({
      answer: "the sky is blue because of rayleigh scattering",
      results: [
        { title: "why is the sky blue", url: "https://example.com/sky", content: "rayleigh scattering" },
      ],
    })

    const calls: CapturedAdapterCalls = { sendToolResult: [], injectContext: [] }
    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({ blockingToolResponse: true }, calls)
    attachConfigAndAdapter(session, adapter, {
      tavilyApiKey: "tvly-test",
      tavilyEndpoint: `http://127.0.0.1:${httpServer.port}/search`,
    })

    process.env.TAVILY_API_KEY = "tvly-test"
    await invokeServerToolCall(session, "call-block-1", "web_search", { query: "why is the sky blue" })

    expect(calls.sendToolResult).toHaveLength(1)
    expect(calls.sendToolResult[0].callId).toBe("call-block-1")
    expect(calls.sendToolResult[0].output).toContain("rayleigh scattering")
    expect(calls.injectContext).toHaveLength(0)
  })

  it("non-blocking tool: placeholder sendToolResult fires immediately, real result injected later via injectContext", async () => {
    httpServer = await mountBrainMock([
      'data: {"choices":[{"delta":{"content":"the answer"}}]}',
      "data: [DONE]",
    ])
    process.env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${httpServer.port}`

    const calls: CapturedAdapterCalls = { sendToolResult: [], injectContext: [] }
    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({ blockingToolResponse: true }, calls)
    attachConfigAndAdapter(session, adapter, {})

    await invokeServerToolCall(session, "call-async-1", "ask_brain", { query: "what's the meaning of life?" })

    expect(calls.sendToolResult).toHaveLength(1)
    const placeholder = JSON.parse(calls.sendToolResult[0].output) as { status?: string }
    expect(placeholder.status).toBe("searching")

    expect(calls.injectContext).toHaveLength(1)
    expect(calls.injectContext[0]).toContain("the answer")
  })

  it("adapter without blocking capability: blocking tool falls through to placeholder + injectContext", async () => {
    httpServer = await mountTavilyMock({
      answer: "fallback works",
      results: [{ title: "x", url: "https://x", content: "y" }],
    })

    const calls: CapturedAdapterCalls = { sendToolResult: [], injectContext: [] }
    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({ blockingToolResponse: false }, calls)
    attachConfigAndAdapter(session, adapter, {
      tavilyApiKey: "tvly-test",
      tavilyEndpoint: `http://127.0.0.1:${httpServer.port}/search`,
    })

    process.env.TAVILY_API_KEY = "tvly-test"
    await invokeServerToolCall(session, "call-fallback-1", "web_search", { query: "anything" })

    expect(calls.sendToolResult).toHaveLength(1)
    const placeholder = JSON.parse(calls.sendToolResult[0].output) as { status?: string }
    expect(placeholder.status).toBe("searching")

    expect(calls.injectContext).toHaveLength(1)
    expect(calls.injectContext[0]).toContain("fallback works")
  })

  it("web_search is registered as medium latency (blocking)", () => {
    const config = makeConfig({ tavilyApiKey: "tvly-test" })
    const tool = findRelayTool(config, "web_search")
    expect(tool).not.toBeNull()
    expect(tool?.latencyClass).toBe("medium")
    expect(isBlockingLatencyClass(tool!.latencyClass)).toBe(true)
  })

  it("ask_brain is not registered in direct-tools mode", () => {
    const config = makeConfig({})
    expect(findRelayTool(config, "ask_brain")).toBeNull()
  })

  it("echo_tool is registered as fast latency (blocking)", () => {
    const config = makeConfig({})
    const tool = findRelayTool(config, "echo_tool")
    expect(tool).not.toBeNull()
    expect(tool?.latencyClass).toBe("fast")
    expect(isBlockingLatencyClass(tool!.latencyClass)).toBe(true)
  })

  it("blocking ask_brain (config-driven override): abort sends cancellation result", async () => {
    httpServer = await mountStallingMock()
    process.env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${httpServer.port}`

    const calls: CapturedAdapterCalls = { sendToolResult: [], injectContext: [] }
    const ws = makeFakeWs(() => {})
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({ blockingToolResponse: true }, calls)
    attachConfigAndAdapter(session, adapter, {})

    const inner = session as unknown as {
      runBlockingAskBrain: (callId: string, args: string) => void
      inFlightTools: Map<string, AbortController>
    }
    inner.runBlockingAskBrain("call-abort-brain", JSON.stringify({ query: "stalled question" }))

    await waitMs(50)
    const controller = inner.inFlightTools.get("call-abort-brain")
    expect(controller).toBeDefined()
    controller!.abort(new Error("upstream cancelled tool call"))

    await waitForCallToComplete(inner.inFlightTools, "call-abort-brain")

    const cancelled = calls.sendToolResult.find((c) => c.callId === "call-abort-brain")
    expect(cancelled).toBeDefined()
    const payload = JSON.parse(cancelled!.output) as { status?: string }
    expect(payload.status).toBe("cancelled")
  })

  it("runWebSearch abort: cancellation result sent", async () => {
    httpServer = await mountStallingMock()

    const calls: CapturedAdapterCalls = { sendToolResult: [], injectContext: [] }
    const ws = makeFakeWs(() => {})
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({ blockingToolResponse: true }, calls)
    attachConfigAndAdapter(session, adapter, {
      tavilyApiKey: "tvly-test",
      tavilyEndpoint: `http://127.0.0.1:${httpServer.port}/search`,
    })
    process.env.TAVILY_API_KEY = "tvly-test"

    const inner = session as unknown as {
      runWebSearch: (callId: string, args: string) => void
      inFlightTools: Map<string, AbortController>
    }
    inner.runWebSearch("call-abort-web", JSON.stringify({ query: "stalled query" }))

    await waitMs(50)
    const controller = inner.inFlightTools.get("call-abort-web")
    expect(controller).toBeDefined()
    controller!.abort(new Error("upstream cancelled tool call"))

    await waitForCallToComplete(inner.inFlightTools, "call-abort-web")

    const cancelled = calls.sendToolResult.find((c) => c.callId === "call-abort-web")
    expect(cancelled).toBeDefined()
    const payload = JSON.parse(cancelled!.output) as { status?: string }
    expect(payload.status).toBe("cancelled")
  })
})

function makeFakeWs(onSend: (data: string) => void) {
  return {
    OPEN: 1,
    readyState: 1,
    send: onSend,
    close: () => {},
    on: () => {},
  }
}

function makeFakeAdapter(
  capabilities: AdapterCapabilities,
  calls: CapturedAdapterCalls,
): ProviderAdapter {
  return {
    capabilities,
    connect: async () => {},
    sendAudio: () => {},
    commitAudio: () => {},
    sendFrame: () => {},
    createResponse: () => {},
    cancelResponse: () => {},
    sendToolResult: (callId, output) => calls.sendToolResult.push({ callId, output }),
    injectContext: (text) => calls.injectContext.push(text),
    getTranscript: () => [],
    disconnect: () => {},
  }
}

function makeConfig(overrides: Partial<SessionConfigEvent>): SessionConfigEvent {
  return {
    type: "session.config",
    provider: "gemini",
    voice: "test",
    brainAgent: "enabled",
    apiKey: "test-key",
    sessionKey: "test-session",
    ...overrides,
  }
}

function attachConfigAndAdapter(
  session: RelaySession,
  adapter: ProviderAdapter,
  configOverrides: Partial<SessionConfigEvent> & { tavilyEndpoint?: string },
) {
  if (configOverrides.tavilyEndpoint) {
    process.env.TAVILY_ENDPOINT = configOverrides.tavilyEndpoint
  }
  const cfg = makeConfig(configOverrides)
  const inner = session as unknown as {
    config: SessionConfigEvent
    adapter: ProviderAdapter
  }
  inner.config = cfg
  inner.adapter = adapter
}

async function invokeServerToolCall(
  session: RelaySession,
  callId: string,
  name: string,
  args: object,
) {
  const inner = session as unknown as {
    handleServerToolCall: (callId: string, name: string, args: string) => void
    inFlightTools: Map<string, AbortController>
  }
  inner.handleServerToolCall(callId, name, JSON.stringify(args))
  await waitForCallToComplete(inner.inFlightTools, callId)
}

async function waitForCallToComplete(map: Map<string, AbortController>, callId: string) {
  const start = Date.now()
  while (map.has(callId) && Date.now() - start < 3000) {
    await waitMs(10)
  }
  await waitMs(20)
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function mountTavilyMock(payload: {
  answer: string
  results: { title: string, url: string, content: string }[]
}): Promise<MockServerHandle> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      query: "test",
      answer: payload.answer,
      results: payload.results,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function mountStallingMock(): Promise<MockServerHandle> {
  const sockets = new Set<import("node:net").Socket>()
  const server: Server = createServer((_req, _res) => {
    // Never respond — keeps the request hanging until the client aborts or the
    // server closes. Lets tests reach into inFlightTools and trigger an abort
    // while the fetch is genuinely in-flight.
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

async function mountBrainMock(sseLines: string[]): Promise<MockServerHandle> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const line of sseLines) {
      res.write(`${line}\n\n`)
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
