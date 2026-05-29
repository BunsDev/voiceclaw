// Tool definitions for STS sessions
//
// The advertised tool set depends on voiceMode (see types.ts):
//   - "direct"     — read/write/edit/bash (+ web_search if Tavily key set).
//                    The model uses tools itself in-line.
//   - "operator"   — ask_brain (+ web_search if Tavily key set). The realtime
//                    model delegates work to the agent backend; the direct
//                    tools are NOT advertised.
//   - "supervisor" — SCAFFOLD: falls back to "direct" until real supervision
//                    is wired (see ../supervisor.ts).
//
// `experimentalDirectTools` is the legacy gate and is accepted for
// wire-compat only.

import { resolveVoiceMode, type SessionConfigEvent, type VoiceMode } from "../types.js"
import {
  READ_TOOL_DESCRIPTION,
  READ_TOOL_NAME,
  READ_TOOL_PARAMETERS,
} from "./direct/read.js"
import {
  WRITE_TOOL_DESCRIPTION,
  WRITE_TOOL_NAME,
  WRITE_TOOL_PARAMETERS,
} from "./direct/write.js"
import {
  EDIT_TOOL_DESCRIPTION,
  EDIT_TOOL_NAME,
  EDIT_TOOL_PARAMETERS,
} from "./direct/edit.js"
import {
  BASH_TOOL_DESCRIPTION,
  BASH_TOOL_NAME,
  BASH_TOOL_PARAMETERS,
} from "./direct/bash.js"

/**
 * Latency class drives the dispatch strategy in session.ts:
 *  - "fast" (<100ms): run synchronously, model gets the real result inside the turn.
 *  - "medium" (~100ms–2s): block when the adapter supports it.
 *  - "slow" (~2s–30s): non-blocking — relay returns a placeholder, real result
 *    is threaded back via injectContext; the model speaks a verbal bridge.
 *  - "streaming": tool emits tool.progress.textDelta as output streams in;
 *    final result still goes back via injectContext.
 */
export type RelayToolLatencyClass = "fast" | "medium" | "slow" | "streaming"

export interface RelayToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  latencyClass: RelayToolLatencyClass
}

// Tools whose dispatch path should hold the tool call open until the real
// result lands (i.e. the legacy `blocking: true` semantics).
const BLOCKING_LATENCY_CLASSES: ReadonlySet<RelayToolLatencyClass> = new Set([
  "fast",
  "medium",
])

export function isBlockingLatencyClass(latencyClass: RelayToolLatencyClass): boolean {
  return BLOCKING_LATENCY_CLASSES.has(latencyClass)
}

const ECHO_TOOL: RelayToolDefinition = {
  name: "echo_tool",
  description: "Test tool that echoes back whatever you send it. Use this when the user asks to test tools.",
  latencyClass: "fast",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to echo back",
      },
    },
    required: ["message"],
  },
}

const ASK_BRAIN: RelayToolDefinition = {
  name: "ask_brain",
  description: "Ask your brain agent for information, to perform tasks, or to look things up. Use this for anything that requires memory, web access, calendar, tasks, or knowledge beyond what you know. Also use this for deep analysis of articles or content the user shares — send the URL and your question together. Examples: 'What's on my calendar?', 'Create a task to...', 'Look up my open tickets', 'Remember that I decided to...', 'Analyze the article at https://...'",
  latencyClass: "slow",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question or task to send to the brain agent",
      },
    },
    required: ["query"],
  },
}

const WEB_SEARCH: RelayToolDefinition = {
  name: "web_search",
  description: "Fast public web lookup via Tavily. Use this for quick factual questions where the answer lives on the public web — current events, definitions, prices, scores, schedules, recent news, 'what is X', 'when did Y happen'. Much faster than ask_brain (typically 1-3s). Do NOT use for anything personal to the user (their calendar, tasks, memory, files) — those need ask_brain. Returns top results with title, url, and snippet, plus a short synthesized answer when available.",
  latencyClass: "medium",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The web search query — phrase it as you would search Google",
      },
    },
    required: ["query"],
  },
}

const READ_TOOL: RelayToolDefinition = {
  name: READ_TOOL_NAME,
  description: READ_TOOL_DESCRIPTION,
  latencyClass: "fast",
  parameters: READ_TOOL_PARAMETERS as unknown as Record<string, unknown>,
}

const WRITE_TOOL: RelayToolDefinition = {
  name: WRITE_TOOL_NAME,
  description: WRITE_TOOL_DESCRIPTION,
  latencyClass: "fast",
  parameters: WRITE_TOOL_PARAMETERS as unknown as Record<string, unknown>,
}

const EDIT_TOOL: RelayToolDefinition = {
  name: EDIT_TOOL_NAME,
  description: EDIT_TOOL_DESCRIPTION,
  latencyClass: "fast",
  parameters: EDIT_TOOL_PARAMETERS as unknown as Record<string, unknown>,
}

const BASH_TOOL: RelayToolDefinition = {
  name: BASH_TOOL_NAME,
  description: BASH_TOOL_DESCRIPTION,
  latencyClass: "streaming",
  parameters: BASH_TOOL_PARAMETERS as unknown as Record<string, unknown>,
}

export function getRelayTools(config: SessionConfigEvent): RelayToolDefinition[] {
  const tools: RelayToolDefinition[] = [ECHO_TOOL]
  const mode = effectiveVoiceMode(config)

  if (mode === "operator") {
    tools.push(ASK_BRAIN)
  } else {
    // "direct" and "supervisor" (scaffold fallback) both advertise the direct
    // toolset.
    tools.push(READ_TOOL)
    tools.push(WRITE_TOOL)
    tools.push(EDIT_TOOL)
    tools.push(BASH_TOOL)
  }

  if (resolveTavilyKey(config)) {
    tools.push(WEB_SEARCH)
  }

  return tools
}

// Resolve the voiceMode the runtime will actually behave as. Supervisor is a
// SCAFFOLD: it is accepted on the wire but currently behaves like Direct.
// Routed through one helper so the fallback is in exactly one place when the
// real supervisor lands.
export function effectiveVoiceMode(config: SessionConfigEvent): VoiceMode {
  const requested = resolveVoiceMode(config.voiceMode)
  if (requested === "supervisor") {
    // SCAFFOLD: supervisor mode not yet implemented — falls back to direct behavior.
    return "direct"
  }
  return requested
}

// True when at least one tool the model can call returns its result via the
// async placeholder + injectContext path. Used to gate prompt rules that only
// matter when the model has to wait on out-of-band results.
export function hasNonBlockingTool(config: SessionConfigEvent): boolean {
  return getRelayTools(config).some((tool) => !isBlockingLatencyClass(tool.latencyClass))
}

export function findRelayTool(config: SessionConfigEvent, name: string): RelayToolDefinition | null {
  return getRelayTools(config).find((tool) => tool.name === name) ?? null
}

// OpenAI Realtime API tool format
interface RealtimeTool {
  type: "function"
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function getTools(config: SessionConfigEvent): RealtimeTool[] {
  return getRelayTools(config).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

// Resolve Tavily key from session config first, env as fallback. Exported so
// session.ts uses the same precedence when handling tool calls.
export function resolveTavilyKey(config: SessionConfigEvent): string | null {
  const fromConfig = config.tavilyApiKey?.trim()
  if (fromConfig) return fromConfig
  const fromEnv = process.env.TAVILY_API_KEY?.trim()
  if (fromEnv) return fromEnv
  return null
}

// Gemini function declaration format (no type:"function" wrapper)
interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function getGeminiTools(config: SessionConfigEvent): GeminiFunctionDeclaration[] {
  return getRelayTools(config).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

/** Run a server-side tool whose result is computed in-process. Returns null
 * when the tool requires async out-of-process execution (handled by session). */
export function executeSyncTool(
  name: string,
  args: string,
): string | null {
  switch (name) {
    case "echo_tool": {
      const parsed = JSON.parse(args)
      return JSON.stringify({ echoed: parsed.message })
    }
    case "ask_brain":
    case "web_search":
    case READ_TOOL_NAME:
    case WRITE_TOOL_NAME:
    case EDIT_TOOL_NAME:
    case BASH_TOOL_NAME:
      return null
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` })
  }
}
