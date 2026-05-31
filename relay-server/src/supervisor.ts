// Supervisor mode entry point — SCAFFOLD ONLY.
//
// The eventual supervisor agent observes the live realtime conversation
// (transcripts, tool calls, latency signals) and steers it: nudging the
// realtime model back to the task, pausing on dangerous calls, or escalating
// to the agent backend selected by `agentBackend`. None of that exists yet.
//
// Today, when voiceMode === "supervisor":
//   - session.config still flows through (the enum is accepted end-to-end).
//   - getRelayTools() falls back to the Direct tool set.
//   - buildInstructions() falls back to the Direct preamble.
//   - A one-line log is emitted on selection.
//
// When real supervision lands, replace `noteSupervisorSelected` with a real
// constructor that:
//   1. Subscribes to RelayEvent stream (transcript.delta, tool.call, etc.).
//   2. Spawns / connects to the chosen AgentBackend (see agents.ts).
//   3. Emits steering signals back via the existing injectContext path on
//      the active adapter.

import type { AgentBackend } from "./types.js"
import { log } from "./log.js"

// TODO(supervisor): turn this into a real Supervisor class that holds adapter
// + tracer refs and consumes RelayEvents. For now it's a marker call site so
// session.ts has one explicit place to wire the real thing later.
export function noteSupervisorSelected(sessionId: string, backend: AgentBackend): void {
  log(`[session:${sessionId}] SCAFFOLD: supervisor mode not yet implemented — falls back to direct behavior (backend=${backend})`)
}
