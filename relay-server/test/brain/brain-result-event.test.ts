import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { context, propagation, trace } from "@opentelemetry/api"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"
import { RelaySession } from "../../src/session.js"
import type { ProviderAdapter } from "../../src/adapters/types.js"
import type { RelayEvent, SessionConfigEvent } from "../../src/types.js"

interface BrainServer {
  port: number
  close: () => Promise<void>
}

describe("brain.result event", () => {
  let brainServer: BrainServer | null = null

  beforeAll(() => {
    const provider = new BasicTracerProvider()
    trace.setGlobalTracerProvider(provider)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    const ctxManager = new AsyncHooksContextManager().enable()
    context.setGlobalContextManager(ctxManager)
  })

  afterEach(async () => {
    if (brainServer) {
      await brainServer.close()
      brainServer = null
    }
  })

  afterAll(() => {
    delete process.env.BRAIN_GATEWAY_URL
    delete process.env.OPENCLAW_GATEWAY_URL
  })

  it("emits brain.result on successful response before injecting context", async () => {
    brainServer = await mountBrainServer((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n')
      res.write("data: [DONE]\n\n")
      res.end()
    })
    process.env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${brainServer.port}`

    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)

    const injectOrder: string[] = []
    const adapter = makeFakeAdapter({
      onInjectContext: (text) => injectOrder.push(text),
      onSendToolResult: () => {},
    })
    attachConfigAndAdapter(session, adapter)

    await invokeAskBrain(session, "call-success", { query: "what's the weather?" })

    const brainEvent = sentEvents.find((e) => e.type === "brain.result")
    expect(brainEvent).toBeDefined()
    expect(brainEvent).toMatchObject({
      type: "brain.result",
      callId: "call-success",
      query: "what's the weather?",
      result: "hello world",
    })
    expect((brainEvent as { error?: string }).error).toBeUndefined()

    expect(injectOrder).toHaveLength(1)
    expect(injectOrder[0]).toContain("hello world")

    const sentTypes = sentEvents.map((e) => e.type)
    expect(sentTypes.indexOf("brain.result")).toBeGreaterThanOrEqual(0)
  })

  it("emits brain.result with error on brain failure", async () => {
    // Point at a port that has no listener; fetch rejects, askBrain throws,
    // and session.ts's .catch branch fires with the error message.
    process.env.BRAIN_GATEWAY_URL = "http://127.0.0.1:1"

    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({
      onInjectContext: () => {},
      onSendToolResult: () => {},
    })
    attachConfigAndAdapter(session, adapter)

    await invokeAskBrain(session, "call-fail", { query: "broken query" })

    const brainEvent = sentEvents.find((e) => e.type === "brain.result") as
      | { type: "brain.result", callId: string, query: string, result?: string, error?: string }
      | undefined
    expect(brainEvent).toBeDefined()
    expect(brainEvent?.callId).toBe("call-fail")
    expect(brainEvent?.query).toBe("broken query")
    expect(brainEvent?.error).toBeTruthy()
    expect(brainEvent?.result).toBeUndefined()
  })

  it("does not emit brain.result on cancellation", async () => {
    let respondNow: (() => void) | null = null
    brainServer = await mountBrainServer((res) => {
      respondNow = () => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"choices":[{"delta":{"content":"late"}}]}\n\n')
        res.write("data: [DONE]\n\n")
        res.end()
      }
    })
    process.env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${brainServer.port}`

    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)

    const adapter = makeFakeAdapter({
      onInjectContext: () => {},
      onSendToolResult: () => {},
    })
    attachConfigAndAdapter(session, adapter)

    const callPromise = invokeAskBrain(session, "call-cancel", { query: "long running" })

    await waitMs(50)
    const inFlight = (session as unknown as { inFlightTools: Map<string, AbortController> }).inFlightTools
    const controller = inFlight.get("call-cancel")
    expect(controller).toBeDefined()
    controller!.abort(new Error("user moved on"))

    if (respondNow) (respondNow as () => void)()
    await callPromise

    const brainEvent = sentEvents.find((e) => e.type === "brain.result")
    expect(brainEvent).toBeUndefined()
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

function makeFakeAdapter(handlers: {
  onInjectContext: (text: string) => void
  onSendToolResult: (callId: string, output: string) => void
}): ProviderAdapter {
  return {
    capabilities: { blockingToolResponse: true },
    connect: async () => {},
    sendAudio: () => {},
    commitAudio: () => {},
    sendFrame: () => {},
    createResponse: () => {},
    cancelResponse: () => {},
    sendToolResult: handlers.onSendToolResult,
    injectContext: handlers.onInjectContext,
    getTranscript: () => [],
    disconnect: () => {},
  }
}

function attachConfigAndAdapter(session: RelaySession, adapter: ProviderAdapter) {
  const cfg: SessionConfigEvent = {
    type: "session.config",
    provider: "gemini",
    voice: "test",
    brainAgent: "enabled",
    apiKey: "test-key",
    sessionKey: "test-session",
  }
  const inner = session as unknown as {
    config: SessionConfigEvent
    adapter: ProviderAdapter
  }
  inner.config = cfg
  inner.adapter = adapter
}

async function invokeAskBrain(session: RelaySession, callId: string, args: object) {
  const inner = session as unknown as {
    handleAskBrain: (callId: string, args: string) => void
    inFlightTools: Map<string, AbortController>
  }
  inner.handleAskBrain(callId, JSON.stringify(args))
  await waitForCallToComplete(inner.inFlightTools, callId)
}

async function waitForCallToComplete(map: Map<string, AbortController>, callId: string) {
  const start = Date.now()
  while (map.has(callId) && Date.now() - start < 3000) {
    await waitMs(10)
  }
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function mountBrainServer(handler: (res: import("node:http").ServerResponse) => void): Promise<BrainServer> {
  const server: Server = createServer((_req, res) => handler(res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
