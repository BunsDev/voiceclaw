# Self-contained VoiceClaw desktop DMG: packaging design

**Author:** Claude (recon, read-only)
**Date:** 2026-04-29
**Scope:** What it would take to ship a fully self-contained `VoiceClaw.dmg` that bundles the relay-server AND the openclaw brain gateway, so a fresh Mac install Just Works — no `git clone`, no separate `yarn dev`, no manual openclaw setup.

## 1. Current state (verified)

- `desktop/electron-builder.yml:17-21` `extraResources` only ships `desktop/resources/` (tray glyphs, dock icon, etc.). No relay-server, no openclaw binary, no Node runtime. Confirmed.
- `desktop/src/main/services/openclaw-gateway.ts:42-55` `resolveBundledBinary()` looks for `Resources/bin/openclaw-gateway-darwin-<arch>` in packaged builds and `desktop/resources/bin/...` in dev. The directory does not exist yet. The comment refers to "PR #0 (yagudaev/openclaw release pipeline)" — that PR does not exist either. Open PRs in the fork are #1-3 (Langfuse tracing) and four merged Michael branches; none ship a gateway binary.
- `desktop/src/main/services/service-manager.ts` has spawn / log-routing / status events / `stopAll()`. **It does NOT do health checks** — `healthCheckUrl` is part of `ServiceDefinition` but the manager never polls it. Status flips to `running` immediately after `spawn()` returns; only an `exit`/`error` event flips it to `crashed`. Worth noting for the design.
- `desktop/src/main/index.ts:160-164` calls `startBundledOpenClaw()` best-effort. There is **no** `startBundledRelay()` call anywhere.
- `desktop/src/main/ports.ts:11-18` already declares `'relay'`, `'openclawGateway'`, `'tracingCollector'`, `'tracingUi'` as the four service names with preferred ports — so the scaffolding contemplates the relay being managed here too, but the spawn wiring isn't written.
- `relay-server/package.json` runtime deps: `@langfuse/*`, `@opentelemetry/*`, `dotenv`, `express`, `ws`. **Zero native modules.** The relay is run via `tsx` in dev and `tsc` → `node dist/index.js` in prod (Dockerfile path).
- `tracing-collector/package.json` does have `better-sqlite3` (a native module). The desktop main process also depends on `better-sqlite3` and runs `electron-rebuild` post-install. So the desktop already knows how to ship one native module — but the relay does not need any of that.
- `openclaw/` (fork at `/Users/michaelyagudaev/code/voiceclaw/openclaw`) is published to npm as `openclaw@2026.4.x` (last published 2026.4.26, 71.8 MB unpacked). The Mac companion (Sparkle/SwiftUI menu bar app at `apps/macos/`) is shipped separately as a signed `.zip` via `appcast.xml`. **There is no prebuilt single-file `openclaw-gateway` binary anywhere.** The `gateway` subcommand exists (`gateway:dev` script in `openclaw/package.json:1308`) but only as `node scripts/run-node.mjs --dev gateway` — it requires Node ≥22.12 and the unpacked node_modules tree.
- `desktop/src/main/brain-detect.ts` already detects locally-installed `claude` and `codex` CLIs by `which`. The onboarding `StepBrain.tsx` shows OpenClaw labeled "(bundled)" with the "Built in" pill regardless of whether the binary actually exists — this is a UI lie today.
- Onboarding wizard exists: 6 steps in `desktop/src/renderer/src/pages/onboarding/`. Step 4 (`StepProvider.tsx`) collects a Gemini/xAI key and validates it via Electron `net.fetch`. Keys land in `provider_keys` SQLite table encrypted via `safeStorage` (Keychain). **No `~/.openclaw/openclaw.json` bootstrap exists** — if the user picks "openclaw" they currently get the missing-binary skip path.
- Logs go to `~/Library/Logs/VoiceClaw/<service>.log` via `logs.ts` `getLogDir()`. Tray observes `serviceManager.on('change')` and turns red on `crashed`. So when bundled services fail, the user already sees the tray go red (and Console.app shows the log) — the failure mode is at least visible.

## 2. Three packaging options ranked

### Option A — Ship Node runtime + relay source under `Resources/` (recommended)

**How it works.** Add `relay-server/` source (or pre-built `dist/`) and a copy of the `node` binary to `extraResources`. The desktop main process spawns `node Resources/relay-server/dist/index.js` via `serviceManager.start()`. Same approach for openclaw: `node Resources/openclaw/dist/index.js gateway --port <p>`.

**Binary size.** Node 22 macOS-arm64 ≈ 60 MB; macOS-x64 ≈ 65 MB. Universal Node binary (lipo) ≈ 125 MB. Plus relay `dist/` (≈ 1-2 MB compiled JS + node_modules pruned to runtime ≈ 20-40 MB depending on tree-shaking), plus openclaw npm tarball (71.8 MB unpacked). Total: **~220-280 MB** added to the DMG.

**Signing.** Each `.node` file (none for relay, several inside openclaw's `node_modules` for `sqlite-vec`, `proxy-agent`'s deps, etc.) and the `node` binary itself need to appear in `electron-builder.yml`'s `binaries` array (or be discovered by `@electron/osx-sign`'s default sweep, which does walk `Resources/`). Each child binary inherits the app's hardened-runtime entitlements via `entitlementsInherit`. Validated: this path is well-trodden — the Electron docs explicitly list this pattern for "bundling Python/Node sidecars".

**Dev/prod parity.** Highest. The same `node` + same source runs in dev (just from `relay-server/src` via `tsx`) and prod (from `Resources/relay-server/dist`). Bug surface is identical.

**Risk.** Largest DMG of the three options. Otherwise low.

### Option B — Node SEA (Single Executable Application)

**How it works.** Pre-bundle the relay's TS+deps with esbuild into one `index.js`, then run `node --build-sea` (Node 25.5+, January 2026) or the older `postject` flow to inject the bundle into a Node binary, producing `relay-server-darwin-arm64` and `relay-server-darwin-x64`. Same for openclaw's `gateway` entry — but openclaw is much harder, see below.

**Binary size.** ~80-100 MB per arch (Node binary + bundled JS). With two arches × two services that's 4 binaries ≈ 320-400 MB total — actually worse than Option A unless you ship a single arch per DMG (giving up the universal-DMG promise).

**Signing.** SEA-produced binaries are valid Mach-O, sign cleanly with `codesign --options runtime`, and notarize. Each one needs to be listed in electron-builder's `binaries` array.

**Dev/prod parity.** Medium. Dev runs source via tsx; prod runs a frozen bundle. Bundle-time bugs (esbuild misinterpreting a dynamic require, OTel SDK's reflection on instrumentations, `dotenv`'s module loading) only surface in packaged builds. The relay's `@opentelemetry/sdk-node` uses `require.resolve()` for instrumentation discovery in places — historically a SEA pain point.

**Risk.** Native modules in SEA are *technically* supported (asset bundling + `process.dlopen()` extract-at-runtime) but the Joyee Cheung blog post (2026-01-26) flags this as awkward in practice. The relay has none, so the relay is fine. **Openclaw absolutely cannot be SEA'd cleanly**: it has 2,471 chunked `dist/*.js` files (jiti-style runtime resolution), 35 deps including `sqlite-vec` (native), and assumes a real `node_modules` filesystem layout. SEA for openclaw is not a serious option.

### Option C — Bun `build --compile`

**How it works.** `bun build --compile --target=bun-darwin-arm64 ./relay-server/src/index.ts --outfile relay-server-darwin-arm64`. Single-binary output, ~60-90 MB.

**Binary size.** Smallest of the three. ~60-90 MB per arch per service.

**Signing.** Currently broken on Bun 1.3.12 (bun#29361, bun#29120, both January-February 2026): the `--compile` output produces a truncated code signature that `codesign` rejects with "invalid or unsupported format for signature". The official Bun guide says "codesign and notarize after compile" but the truncation bug is an active regression that has reappeared in multiple versions. Workaround per the guide is to re-sign with `codesign --remove-signature && codesign --sign --options runtime --entitlements ...`, which works on the working versions but not 1.3.12.

**Dev/prod parity.** Lowest. Dev uses Node via tsx, prod uses Bun runtime. The relay would have to be tested under Bun separately — `@opentelemetry/sdk-node` and `@langfuse/*` may or may not work cleanly under Bun's Node-compat shims (we'd need to test). Adopting Bun for the desktop's bundled relay also means our backend dev story diverges from the Docker prod path (which uses Node).

**Risk.** Bun signing regression is alive in 2026 — pinning to a known-good version mitigates but adds maintenance. Two-runtime story (Node in dev, Bun in prod) is a constant footgun source. Not viable for openclaw at all (openclaw expects Node ≥22.12 explicitly per `openclaw.mjs:9-10`).

### Ranking

1. **Option A** (Node + source under Resources). Boring, large, predictable. Ships today.
2. **Option B** (SEA). Reasonable for the relay alone if DMG size matters; bad for openclaw.
3. **Option C** (Bun). Small but Bun signing is unstable in 2026 and openclaw won't run on it.

## 3. Recommended packaging approach

**Ship Node 22 LTS + the relay's compiled `dist/` + the openclaw npm tarball under `Contents/Resources/` (Option A).** Spawn each via the existing `serviceManager`. Add a real health-check loop to `service-manager.ts` (the field exists but the poller doesn't). Use a single Node binary shared by both services — saves ~125 MB vs. two SEA binaries. Accept the +250 MB DMG cost; users download the app once.

**Why not bundle openclaw itself?** Two options on this dimension:

- **A1 — Vendor openclaw at build time.** Desktop's `dist:mac` script does `npm pack openclaw@<pinned>` then unpacks the tarball into `desktop/resources/openclaw/`. Pin a version in `desktop/package.json` to keep the upgrade story controlled. DMG carries the exact bytes. Reproducible; offline-installable.
- **A2 — Download openclaw on first run.** Desktop ships the Node binary and the relay; on first run after install (or first time the user picks "OpenClaw" in the wizard), it downloads `openclaw-<version>.tgz` from npm into `app.getPath('userData')`. Smaller DMG (~150 MB lighter), but breaks offline install and adds a first-run failure mode.

Recommend **A1**. The "no surprises after install" bar matters more than DMG size for a self-contained promise. The pinned version also ensures every user of a given desktop release runs the same brain version — easier support.

## 4. Concrete work breakdown

Ordered by dependency. Each item is a separate PR.

### Phase 1 — Bundle the relay

1. **`relay-server/package.json`** — add a `build:bundle` script that runs `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist-bundle/relay.mjs --external:better-sqlite3` (no externals actually needed for relay; this bundles deps in). Keeps the runtime payload small (single file).
2. **`desktop/package.json`** — add a `prepackage:relay` script that builds the relay bundle then copies `dist-bundle/relay.mjs` to `desktop/resources/relay-server/relay.mjs`.
3. **`desktop/scripts/with-build-env.mjs`** (or a new `prepare-bundled-services.mjs`) — download the appropriate Node binary (`node-v22.x-darwin-x64.tar.xz`, `node-v22.x-darwin-arm64.tar.xz`), extract `bin/node`, write to `desktop/resources/bin/node-darwin-x64` and `node-darwin-arm64`. Use `lipo` to create a universal `node`. Cache by version under `desktop/.cache/node-runtime/`.
4. **`desktop/electron-builder.yml`** — extend `extraResources`:
   ```
   - from: "resources/bin"
     to: "bin"
   - from: "resources/relay-server"
     to: "relay-server"
   ```
   Add `mac.binaries: ["bin/node"]` so `@electron/osx-sign` signs the Node binary.
5. **`desktop/src/main/services/relay-server.ts`** (new) — analogous to `openclaw-gateway.ts`:
   - resolve `Resources/bin/node` and `Resources/relay-server/relay.mjs`
   - allocate port via `allocatePort('relay')`
   - read provider keys from SQLite (decrypt via `safeStorage`) and pass as env (`GEMINI_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`)
   - call `serviceManager.start({ command: nodeBin, args: [bundlePath], port, env, healthCheckUrl: '/health', logFile: 'relay-server.log' })`
6. **`desktop/src/main/index.ts`** — call `startBundledRelay()` next to `startBundledOpenClaw()`.
7. **`desktop/src/main/services/service-manager.ts`** — add the health-check poll (every 2 s for the first 30 s, then every 30 s). Status `running` only flips after the first successful 200 from `healthCheckUrl`. Failure transitions to `crashed`.

### Phase 2 — Bundle openclaw

8. **`desktop/scripts/prepare-bundled-services.mjs`** — extend to `npm pack openclaw@<pinned>` into `desktop/resources/openclaw/`, then `tar -xzf` and `npm install --production --omit=dev` inside that dir to materialize the deps. Cache by version. (Note: openclaw's `postinstall` runs `postinstall-bundled-plugins.mjs` — that script needs to be tolerant of running at build time vs. runtime; verify before shipping.)
9. **`desktop/electron-builder.yml`** — add `from: "resources/openclaw"` to `extraResources`. List any `*.node` files under openclaw's tree in `mac.binaries` (sqlite-vec ships prebuilds — these need to be signed too).
10. **`desktop/src/main/services/openclaw-gateway.ts`** — replace the dead `resolveBundledBinary()` path with `node Resources/openclaw/dist/index.js gateway --port <p>`. Set `OPENCLAW_HOME=app.getPath('userData')/openclaw` so the bundled brain doesn't collide with a user's existing `~/.openclaw`.
11. **First-run config bootstrap** — write a default `~/.voiceclaw/openclaw/openclaw.json` (or wherever `OPENCLAW_HOME` points) with the same provider key the user gave in step 4 of onboarding, so `claude-cli` / `codex-cli` / direct provider works immediately. Today's `provider_keys` table is the source.

### Phase 3 — Onboarding tightening

12. **`desktop/src/renderer/src/pages/onboarding/StepBrain.tsx`** — only show the "Built in" pill when `binary present + service-manager reports running`. Today's UI claims bundled even when missing — that'll bite us when bundling lands and silently fails.
13. **`desktop/src/main/brain-detect.ts`** — add `openclaw: { available: <serviceManager status === running> }` instead of always-true.
14. **Docs** — `docs/src/content/docs/desktop-app.mdx` should grow a "Self-contained install" section explaining what's bundled, where logs land, how to reset, and the new "openclaw failed to start" surface.

### Phase 4 — Auto-update parity

15. **Smoke test** — verify `electron-updater` differential update (the `.blockmap` artifact) handles a relay-binary swap cleanly. Add a release-note checklist item: "If a release changes a bundled service binary, bump the desktop version even for relay-only changes."

## 5. Per-area effort estimate

| Area | Size | Hours | Notes |
|------|------|-------|-------|
| Bundle relay (Phase 1, items 1-6) | **Medium** | 8-14 | Mostly mechanical; the Node-binary download script is the unknown. Health-check addition is a clean add. |
| Service-manager health checks (item 7) | **Small** | 2-4 | The status types already model `'starting' → 'running'`; just need the poller. |
| Bundle openclaw (Phase 2, items 8-10) | **Large** | 16-30 | `npm pack` + `npm install --production` inside a build step is fiddly. Openclaw's `postinstall` may resist running at build time. `OPENCLAW_HOME` plumbing requires reading openclaw to confirm the env var name (verify before estimating final). |
| First-run config bootstrap (item 11) | **Medium** | 6-10 | Writing one JSON file is trivial; deciding what defaults to seed (which agent? what model?) is the design call. |
| Onboarding tightening (Phase 3) | **Small** | 3-5 | UI string + one new IPC handler. |
| Signing & notarization tuning | **Medium** | 4-8 | First time `electron-builder` walks Node + sqlite-vec `.node` files there will be at least one notarization rejection. Budget for one round trip with Apple. |
| Docs + release-notes update | **Small** | 2-3 | One Starlight page; a bullet in `docs/src/content/docs/operations/`. |
| **Total** | | **41-74** | One developer-week to two developer-weeks. |

Recommended sequencing: Phase 1 first (lands a usable bundled relay even without openclaw — most users on Gemini/xAI direct don't need openclaw at all). Then Phase 3 (UI lie fix). Then Phase 2 (openclaw — the biggest unknown). Phase 4 last.

## 6. Open questions (need user input)

1. **Do we ship openclaw bytes inside the DMG, or download on first run?** Recommendation in §3 is bundle (A1), but this trades ~70 MB for offline installability. **Highest-leverage decision** — affects Phase 2 entirely.
2. **Pinned openclaw version vs. floating "latest"?** Pinning is safer for support but means desktop releases must follow openclaw releases. Floating means a remote openclaw bug can break a user's already-installed VoiceClaw.
3. **Where should the bundled openclaw write its workspace?** `~/.openclaw/` (collide with a user who also has standalone openclaw installed) or `~/Library/Application Support/VoiceClaw/openclaw/` (clean isolation, but their existing memory/skills don't carry over)? Default: isolated, with a "Import from ~/.openclaw" wizard option.
4. **Do we still detect & offer claude/codex CLIs, or hide them once openclaw is reliably bundled?** Today's `StepBrain.tsx` lists three options. If openclaw bundling is rock-solid, the others become "advanced".
5. **Should the bundled relay support the "bring your own .env file" path?** Some users will want to override Gemini key per-session, OTel collector endpoint, etc. Today the relay reads `process.env`; the desktop wrapper would have to surface that.
6. **DMG size budget.** Today's DMG is roughly 110-130 MB (Electron + the JS bundle). Adding ~250 MB takes us to ~380 MB. Is that acceptable for a "Just Works" promise, or do we need to investigate slimmer Node distributions (custom node with `--without-intl`, etc.)?

## 7. Risks / what could go wrong

- **Native modules inside openclaw's tree.** `sqlite-vec` ships prebuilt `.node` files for darwin-arm64/x64; if `npm install --production` at build time picks a Linux variant (because the build happens in CI Linux runners), runtime crash. Mitigation: build the bundle on a macOS runner, or explicitly `npm install --target_platform=darwin --target_arch=<arch>`.
- **Gatekeeper rejects unsigned sub-binaries.** Any `.node` file or the bundled `node` binary that isn't in `mac.binaries` (or auto-discovered) will crash with `code=-67050` ("invalid signature") on first launch on a fresh Mac. Mitigation: add a CI step that runs `codesign --verify --deep --strict <App>` and fails if any nested binary is unsigned.
- **Entitlements mismatch on spawn.** Spawned binaries inherit hardened-runtime entitlements via `entitlementsInherit`. The relay needs `network.client` (already present) and `network.server` (already present per `entitlements.mac.plist:33-34`). Openclaw needs `network.client`, possibly more if it shells out to extensions. Mitigation: test each subsystem after the first signed build.
- **Auto-update silently runs an old service binary.** `electron-updater` swaps the `.app` atomically, but a session that started before the update keeps the *old* spawned `node` process alive until restart. Mitigation: after update install, prompt the user to relaunch (the existing updater UX should already do this — verify).
- **Openclaw `postinstall` at build time.** Running `npm install --production` on the openclaw tarball at build time will trigger `postinstall-bundled-plugins.mjs`, which assumes a real install context. May write into the build directory. Mitigation: investigate `--ignore-scripts` and run the postinstall manually with controlled env.
- **Port conflicts with an existing standalone openclaw.** Per `feedback_relay_is_per_user` and `project_openclaw_fork_runtime` notes, some developers/users run a system-level openclaw on `:18789`. The bundled gateway's `allocatePort('openclawGateway')` already tries the preferred port and falls back to ephemeral — verified working — but the user needs to know which one VoiceClaw is talking to. Surface in the Settings page.
- **Dev/prod path divergence in `resolveBundledBinary`.** Today's `openclaw-gateway.ts:53` looks at `__dirname/../../resources/bin/...`. Once `electron-vite` outputs to `out/main/`, the relative depth is correct. But adding the relay path needs to mirror this exactly — easy to miscount `..`s.
- **`better-sqlite3` is in tracing-collector, not relay.** Tracing-collector is a separate workspace not currently bundled in desktop. If/when we bundle it, the native rebuild story is more complex than the relay's. Out of scope for this design but flagging.
- **Universal DMG size + universal Node.** A universal Node binary via `lipo` is ~125 MB. If we ship arch-specific DMGs instead, each is ~70 MB lighter. Currently `electron-builder.yml:30-31` ships a universal DMG. Stay universal — the support savings outweigh the bytes.

---

**Sources consulted:**

- Node.js v25 SEA docs and Joyee Cheung's "Improving SEA Building" post (2026-01-26)
- Bun signing regression: oven-sh/bun#29361, oven-sh/bun#29120 (both early 2026)
- vercel/pkg deprecation status (deprecated 2024; yao-pkg fork active)
- electron-builder MacConfiguration `binaries` & `entitlementsInherit` docs
- `appcast.xml` and `apps/macos/Package.swift` in the openclaw fork (Sparkle/SwiftUI distribution path)
- `openclaw@2026.4.26` npm metadata (71.8 MB unpacked, deps include `sqlite-vec` 0.1.9)
