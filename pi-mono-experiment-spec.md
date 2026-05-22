# Direct-tools experiment: give the realtime agent the tools

**Author:** Claude + Michael (spec)
**Date:** 2026-05-22
**Status:** Spec — implementation not started.

## 1. Context

Today, VoiceClaw's realtime voice model has one escalation tool — `ask_brain` — which delegates everything non-conversational (memory, files, web, multi-step reasoning) to an out-of-process brain agent (OpenClaw / Hermes) over OpenAI-compatible chat completions. The realtime model stays thin; the brain does the work.

This experiment flips that. Give the realtime model direct tool capability, no brain in the loop for the default path. As realtime models get better, we expect to keep giving them more direct responsibility — this is the first step.

**Key architectural framing.** A realtime model is event-driven, not imperative. The standard agent-loop pattern (`while (!done) { llm.call(); runTools(); }`) used by Claude in openclaw, codex, and pi-mono itself **has nowhere to live** in our architecture — the realtime API *is* the loop. We register tools and react to its events; we don't drive the loop. This is why we don't vendor pi-mono's agent harness, and why the implementation surface is small.

## 2. Goals

- Realtime model calls `read`, `write`, `edit`, `bash`, `web_search` directly via the relay-server, no brain hop.
- File-based memory on the user's machine in `~/.voiceclaw/workspace/`, preloaded into the system prompt at session start. No external memory service required.
- Tool calls render clearly in desktop + mobile transcripts (companion PRs — see §11).
- Gated by a `experimentalDirectTools` flag on `SessionConfigEvent` so production keeps today's behavior unchanged.
- Can A/B against brain-mode on the same prompts.

## 3. Non-goals

- No supervisor agent. The realtime model dispatches to traditional imperative-loop agents (Claude Code, codex) via `bash` when it needs deep multi-step work. Those *are* the supervisors for the specific tasks they handle.
- No vendoring of pi-mono. We DIY the four tool implementations, lifting design patterns (descriptions, denylist regex, workspace scoping, output truncation, `edit` semantics) but no runtime dependency.
- No per-call approval UI. Captured as a follow-up. Day-one safety is denylist + workspace scoping only.
- No generalized `ask_agent` tool yet. Future work; for now `bash claude -p ...` covers it raw.
- No long native-tool roadmap. Four primitives + dynamic composition (skills / model-written one-liners) covers the long tail.

## 4. The five tools

| Tool | Latency class | Args | Returns |
|------|---------------|------|---------|
| `read` | fast | `{ path, offset?, limit? }` | line-numbered file content, capped |
| `write` | fast | `{ path, content }` | `{ written: true, bytes }` |
| `edit` | fast | `{ path, old_string, new_string, replace_all? }` | `{ replaced: count }` |
| `bash` | streaming | `{ command, timeout_ms? }` | streamed stdout/stderr via `tool.progress.textDelta`; final result = exit code + tail |
| `web_search` | medium | `{ query }` | top results + synthesized answer (unchanged from today) |

`ask_brain` is **removed** from the tool list when `experimentalDirectTools=true`. It stays in the codebase, just not exposed to the model in this mode.

### 4.1 Latency classes

Replace today's `blocking: boolean` field on `RelayToolDefinition` with:

```ts
latencyClass: 'fast' | 'medium' | 'slow' | 'streaming'
```

The adapter and instructions use this to decide strategy:

- **fast** (<100ms): block — model gets result inside the turn, no verbal bridge.
- **medium** (100ms-2s): block — short filler if the adapter supports it.
- **slow** (2s-30s): non-blocking — verbal bridge, result injected when ready.
- **streaming** (anything with `tool.progress.textDelta`): non-blocking — bridge, stream progress, inject final result.

We may later observe + adapt classes per-call based on measured latency, but static classes are the right starting point.

### 4.2 Tool implementation notes

- **`read`** — `fs.promises.readFile` + line numbering + 100KB cap with truncation hint.
- **`write`** — `fs.promises.writeFile`, parent-directory creation. Path validated against workspace root (§5.2).
- **`edit`** — exact-string find/replace. Match pi-mono's semantics verbatim where reasonable: error if `old_string` not unique unless `replace_all`, error if `old_string` not found, preserve trailing newline behavior. This is the one tool whose correctness is fiddly; lift the design from pi-mono's `packages/coding-agent` source as a reference.
- **`bash`** — `child_process.spawn`, stdout/stderr streamed as `tool.progress.textDelta`, exit code in final result. Output capped per stream (e.g., 16KB tail) so a `gh pr diff` on a huge PR doesn't blow the model's context. Workspace-root cwd by default. Hard timeout (default 30s, cap 120s). Denylist (§5.3) checked before exec.
- **`web_search`** — unchanged; already in `relay-server/src/tools/web-search.ts`.

## 5. Workspace + memory

### 5.1 Workspace layout

Default workspace: `~/.voiceclaw/workspace/`. Created on first session if missing. Layout mirrors openclaw's conventions so the user's intuition transfers:

```
~/.voiceclaw/workspace/
  AGENTS.md             # protocol the model reads — when to save memory, format conventions
  memory/
    2026-05-22.md       # one append-only markdown file per day
    2026-05-21.md
    ...
  .transcripts/         # raw session transcripts (optional, for future "dreaming"-style consolidation)
```

The user can `vim`, `grep`, sync via Dropbox/iCloud, and back up trivially. Memory is plain text the user owns.

### 5.2 Path scoping

`write` and `edit` reject paths outside the workspace root. `read` is allowed to read anywhere on the machine (it's read-only and the model often needs to inspect code outside `~/.voiceclaw/`). Resolve `realpath` before the check to catch symlink escapes (codex flagged this — TOCTOU race needs handling: validate then open, fail if mismatch).

### 5.3 `bash` denylist

Hard-block before exec:

- `rm -rf` (or any `rm` with `-r` + absolute path outside workspace)
- `sudo`, `doas`
- `curl ... | sh`, `wget ... | sh` (pipe-to-shell anti-pattern)
- Shell metacharacter abuse around credentials paths (`~/.ssh`, `~/.aws`, etc.)

Lift the exact patterns from pi-mono. This is not "secure" — a determined adversary defeats it trivially — but it stops a voice misfire from nuking the machine on day one.

### 5.4 Session-start memory preload

At session start, the relay:

1. Ensures `~/.voiceclaw/workspace/` exists with a default `AGENTS.md` if missing.
2. Reads `AGENTS.md`.
3. Reads `memory/YYYY-MM-DD.md` for today + previous 7 days (existing files only).
4. Injects all of the above into the system prompt under a clearly-labeled section.

This gets memory in-context from word one. No tool round-trip latency on the first "what did we talk about yesterday?" question.

The model writes new memory by `write` / `edit` on the appropriate day file. `AGENTS.md` instructs it to append `## Voice Note (HH:MM)` sections, matching openclaw's format so a user running both gets compatible files.

## 6. Instructions

In `relay-server/src/instructions.ts`, add a conditional block when `experimentalDirectTools=true`:

> **You have direct tools on the user's machine.**
>
> - `read` to inspect files (anywhere). Fast — just wait for the result.
> - `write` and `edit` to modify files inside your workspace (`~/.voiceclaw/workspace/`). Fast.
> - `bash` to run commands. Output streams to you as it comes. Bash and the bridge: when bash will take more than a couple seconds, speak a short bridge while you wait, then keep talking when output arrives.
> - `web_search` for quick public facts.
>
> **Your memory lives in `~/.voiceclaw/workspace/memory/YYYY-MM-DD.md`.** Today's file and the last week have been preloaded for you below. To save something durable, append a `## Voice Note (HH:MM)` section to today's file using `write` or `edit`.
>
> **For multi-step work** (refactors, bug investigations, writing code) — delegate via `bash claude -p "<task>"` or `bash codex "<task>"`. Those are imperative-loop agents that will do the work in their own loop and stream progress back to you. Narrate what they're doing to the user as their output arrives.

(Final wording to be tuned during implementation — this is the substance.)

## 7. File map

**Modified:**

- `relay-server/src/types.ts` — add `experimentalDirectTools?: boolean` to `SessionConfigEvent`.
- `relay-server/src/tools/index.ts` — register the four new tools; replace `blocking: boolean` with `latencyClass`; when flag on, exclude `ask_brain` and include the four + keep `web_search`.
- `relay-server/src/session.ts` — extend dispatch for the four tools (mirrors `runWebSearch` / `handleAskBrain` patterns); ensure workspace exists; preload memory into instructions.
- `relay-server/src/instructions.ts` — add the direct-tools preamble + memory-preload section.
- `relay-server/src/adapters/openai.ts` and `gemini.ts` — update wherever `blocking` is consumed to use `latencyClass`.

**Added:**

- `relay-server/src/tools/direct/read.ts`
- `relay-server/src/tools/direct/write.ts`
- `relay-server/src/tools/direct/edit.ts`
- `relay-server/src/tools/direct/bash.ts`
- `relay-server/src/workspace.ts` — ensure-exists, path-scope check, denylist, memory-file resolution, default `AGENTS.md` content.

**Tests:**

- `relay-server/test/tools/direct/{read,write,edit,bash}.test.ts` — unit per tool, path scoping, denylist.
- `relay-server/test/workspace.test.ts` — ensure-exists, symlink escape, default AGENTS.md.
- `relay-server/test/session/tool-blocking.test.ts` — extend for `latencyClass`-based dispatch; assert `ask_brain` is absent when flag on.
- `relay-server/test/instructions.test.ts` — assert preamble + memory preload when flag on.
- `relay-server/test/brain-e2e.test.ts` — confirm flag-off path is byte-identical to today.

## 8. Safety (day-one)

| Surface | Mitigation |
|---------|------------|
| `bash` destructive commands | Denylist (`rm -rf`, `sudo`, pipe-to-shell). |
| `write` / `edit` outside workspace | Path scope to `~/.voiceclaw/workspace/`, realpath check, symlink-escape catch. |
| `bash` runaway commands | Timeout default 30s, hard cap 120s. |
| `bash` output flooding model context | Per-stream tail cap (16KB) with "more available" hint. |
| Auth surface | Tools have no auth-bearing capability beyond what the user's shell has. `bash` inherits the user's environment by design (this is the whole point). |
| Per-call approval | **Not in this experiment.** Spike acceptable; product requirement. Tracked as follow-up. |

A research worker is currently investigating how pi-mono, hermes, openclaw, and mastra handle tool security and what benchmarks exist for realtime-model tool-use safety. Findings will land at `.agent-grid/notes-inbox/tool-security-and-benchmarks-research.md` and may upgrade these mitigations before implementation.

## 9. Acceptance criteria

- Toggling `experimentalDirectTools` on exposes `read`/`write`/`edit`/`bash`/`web_search`, drops `ask_brain`. Toggling off restores today's behavior — `brain-e2e.test.ts` still passes unchanged.
- Voice prompt "read package.json and tell me the dev script" → visible `read` tool call in the transcript, path arg visible, result rendered (depends on §11 PRs).
- Voice prompt "run yarn test" → visible `bash` tool call, stdout streams in transcript live.
- Voice prompt "save that we decided to ship X" → visible `write` or `edit` on today's memory file, content appended in the `## Voice Note (HH:MM)` format.
- Voice prompt "what did we talk about yesterday?" → answered from preloaded memory in <1s, no tool call required.
- Voice prompt "fix the bug in foo.ts" → `bash claude -p "fix the bug in foo.ts"` (or codex), stdout streams to the user via voice narration.
- Path-traversal attempt or denylisted bash → structured error, no execution.
- All new tests pass; existing relay-server tests pass.

## 10. Verification

1. `cd relay-server && yarn test`.
2. `yarn dev` relay-server + desktop + mobile.
3. Enable the flag via the test page at `http://localhost:8080/test` (or desktop settings if added).
4. Run each acceptance prompt above. Capture observations in a follow-up note.
5. Compare side-by-side with `ask_brain` mode on the same prompts.

## 11. Companion PRs (UI)

Tool calls must be visibly first-class in the transcript. Two PRs handle this independently:

- **Mobile** ✅ — branch `experiment/toolcall-mobile-ui` (commit `2750e17` in worktree `../voiceclaw-toolcall-mobile`). Wired the dropped `tool.progress` events end-to-end: `progressText` / `progressStep` on `ToolCallItem`, step caption next to the spinner, "▸ streaming…" affordance on the collapsed row, tail-scrolling stream block surviving completion. Tool-agnostic.
- **Desktop** — pending. Branch `experiment/toolcall-desktop-ui`. Improvements: structured key/value args (not raw JSON), streaming output visible during long calls, errors expanded by default, latency-class indicator (fast/streaming) on the row, step + textDelta visible together. Worker repeatedly hit Anthropic 529 overloaded; retry pending.

This experiment depends on both for a good user experience.

## 12. Out-of-scope follow-ups

- **Per-call approval UI** for `bash` / `write` / `edit`. Cross-process flow: relay pauses → emits `approval.requested` → desktop/mobile renders card → user taps yes/no → relay resumes or aborts. Pi-mono's CLI gate is not directly reusable.
- **`ask_agent(agent, task)`** generalization replacing raw `bash claude -p`.
- **Dreaming-style memory consolidation** sweeping `.transcripts/` into `memory/YYYY-MM-DD.md`. Borrow openclaw's pattern.
- **Permission rules per tool** ("always allow read", "ask before write to outside workspace", "never allow bash on /etc"). Product surface.
- **Audit log** UI for what tools the agent has done.
- **Tool catalog panel** so the user can see what their assistant can do.
- **MCP integration** as the open-standard extension surface for user-installed tools.
- **Latency-adaptive class switching** — observe per-call latency, downgrade tools that turn out to be fast.
- **Supervisor agent** — only if the dispatch-via-bash pattern proves insufficient.
