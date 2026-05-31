import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate the agent workspace so tests never read the developer's real
// ~/.voiceclaw/workspace (identity, memory, facts) — which would make
// instruction-building non-hermetic and machine-dependent.
process.env.VOICECLAW_WORKSPACE = mkdtempSync(join(tmpdir(), "voiceclaw-test-ws-"))
