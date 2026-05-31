// Agent backend registry — describes the host-side CLI / process that
// powers Operator mode (and, eventually, Supervisor mode).
//
// SCAFFOLD: today every backend short-circuits through the existing openclaw
// brain gateway (BRAIN_GATEWAY_URL). The per-backend host invocations below
// are documented intent, not behavior. The wire field flows through, the
// selection is logged, and there is a single obvious home (this file) for
// the real wiring when each integration lands.
//
// Each backend assumes the corresponding CLI is installed on the host as a
// peer dependency. The relay does not bundle them.

import type { AgentBackend } from "./types.js"
import { log } from "./log.js"

export interface AgentBackendDescriptor {
  id: AgentBackend
  label: string
  // How the relay would invoke this backend on the host. Documentation-only
  // until the per-backend wiring is implemented.
  invocation: {
    kind: "cli" | "http"
    // Command name expected on PATH (for kind === "cli") or URL hint
    // (for kind === "http").
    command: string
    // Short note on argument shape / contract. Free text.
    notes: string
  }
  // SCAFFOLD note surfaced in logs whenever this backend is chosen.
  scaffoldNote: string
}

// SCAFFOLD: wire PI/OpenAI/Hermes host CLIs. Each entry is a placeholder
// describing the intended host-side invocation; none of these are actually
// executed yet — operator mode still hits BRAIN_GATEWAY_URL.
export const AGENT_BACKENDS: Record<AgentBackend, AgentBackendDescriptor> = {
  pi: {
    id: "pi",
    label: "PI (pi-mono)",
    invocation: {
      kind: "cli",
      command: "pi",
      // SCAFFOLD: real shape is e.g. `pi run --prompt "<task>" --json`.
      notes: "Pi Mono harness — peer dep, expected on PATH.",
    },
    scaffoldNote: "SCAFFOLD: PI backend selected — routing through openclaw gateway until pi-mono CLI is wired.",
  },
  openai: {
    id: "openai",
    label: "OpenAI (codex)",
    invocation: {
      kind: "cli",
      command: "codex",
      // SCAFFOLD: real shape is e.g. `codex "<task>" --json`.
      notes: "OpenAI Codex CLI — peer dep, expected on PATH.",
    },
    scaffoldNote: "SCAFFOLD: OpenAI backend selected — routing through openclaw gateway until codex CLI is wired.",
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    invocation: {
      kind: "cli",
      command: "hermes",
      // SCAFFOLD: real shape is e.g. `hermes agent run "<task>"`.
      notes: "Hermes agent — peer dep, expected on PATH.",
    },
    scaffoldNote: "SCAFFOLD: Hermes backend selected — routing through openclaw gateway until hermes CLI is wired.",
  },
}

export function getAgentBackend(id: AgentBackend): AgentBackendDescriptor {
  return AGENT_BACKENDS[id]
}

// Single funnel for the "operator picked backend X" log line so the call site
// in session.ts stays focused. Real implementations will replace this with the
// actual invocation routing.
export function logAgentBackendSelection(sessionId: string, id: AgentBackend): void {
  const desc = AGENT_BACKENDS[id]
  log(`[session:${sessionId}] agentBackend=${id} (${desc.label}) — ${desc.scaffoldNote}`)
}
