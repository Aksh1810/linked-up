# Vercel-Only Public Alpha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Linked-Up as a zero-cost personal multiplayer alpha on Vercel, with the host browser running the existing C++/Jolt simulation through WebAssembly and guests connected over WebRTC.

**Architecture:** Vercel serves the Vite client and short TypeScript Functions. Redis for Vercel stores temporary room, presence, rate-limit, and signaling records. A deterministic Emscripten build runs in the host's Web Worker; WebRTC data channels carry guest input and authoritative snapshots.

**Tech Stack:** Vite 8, TypeScript 7, Babylon.js 9, Vercel Functions, Redis for Vercel, WebRTC DataChannels, C++20, Jolt Physics 5.6, CMake, Emscripten, Node test runner, Playwright-compatible browser verification.

**Spec:** `docs/superpowers/specs/2026-09-12-public-alpha-deployment-design.md`

## Global Constraints

- Vercel Hobby only; personal, non-commercial use; no Railway, Fly.io, TURN relay, or always-running server.
- Preserve native C++ local-server development and all four authored maps.
- Production Functions are short-lived and stateless; Redis is authoritative for lobby and signaling state.
- Production gameplay is host-authoritative WebRTC; host exit ends the match.
- Tokens never appear in URLs, public room state, analytics, or logs.
- Production builds must disable the direct `?player=` bypass.
- Write each behavior test first, run it to observe the expected failure, then add only the implementation needed to pass.

---

### Task 1: Shared production contracts and root test harness

**Files:**
- Create: `package.json`
- Create: `shared/lobby-contract.ts`
- Create: `shared/lobby-contract.test.ts`
- Modify: `client/src/lobby-state.ts`
- Modify: `client/src/lobby-state.test.ts`
- Modify: `client/tsconfig.json`

**Interfaces:**
- Produces: `RoomState`, `RoomPlayer`, `RoomSession`, `MapId`, `RobotColor`, `parseRoom()`, `normalizeRoomCode()`, and `isMapId()` from `shared/lobby-contract.ts`.
- Preserves: the client-facing exports currently imported from `client/src/lobby-state.ts` by re-exporting shared contract symbols.

- [ ] **Step 1: Add failing shared-contract tests**

  Add Node tests that parse waiting, starting, and in-game rooms; require a non-null UUID `matchId` for `starting` and `inGame`; reject duplicate colors, unknown maps, and tokens in public room objects. Include this explicit transition assertion:

  ```ts
  const starting = parseRoom({ ...waiting, status: "starting", matchId });
  assert.equal(starting.matchId, matchId);
  assert.throws(() => parseRoom({ ...waiting, status: "starting", matchId: null }));
  ```

- [ ] **Step 2: Run the shared test and confirm RED**

  Run: `node --test shared/lobby-contract.test.ts`

  Expected: FAIL because `shared/lobby-contract.ts` does not exist.

- [ ] **Step 3: Create the root package and shared contract**

  Create a private ESM root package with scripts:

  ```json
  {
    "name": "linked-up-vercel",
    "private": true,
    "type": "module",
    "scripts": {
      "test:api": "node --test shared/*.test.ts api/**/*.test.ts",
      "test": "npm run test:api && npm --prefix client test",
      "build": "npm --prefix client run build"
    },
    "dependencies": {
      "@vercel/node": "13.0.0",
      "redis": "6.2.1"
    },
    "devDependencies": {
      "typescript": "7.0.2"
    }
  }
  ```

  Move the pure room parsing/types into `shared/lobby-contract.ts`. Change the invariant so `waiting` requires `matchId === null`, while `starting` and `inGame` require a UUID. Keep browser storage helpers and UI predicates in `client/src/lobby-state.ts` and re-export shared symbols.

- [ ] **Step 4: Verify GREEN and client compatibility**

  Run: `node --test shared/lobby-contract.test.ts && npm --prefix client test && npm --prefix client run typecheck`

  Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the shared boundary**

  ```sh
  git add package.json shared client/src/lobby-state.ts client/src/lobby-state.test.ts client/tsconfig.json
  git commit -m "refactor: share multiplayer room contract"
  ```

### Task 2: Serverless room domain and storage boundary

**Files:**
- Create: `api/_lib/room-domain.ts`
- Create: `api/_lib/room-domain.test.ts`
- Create: `api/_lib/room-store.ts`
- Create: `api/_lib/memory-room-store.ts`
- Create: `api/_lib/redis-room-store.ts`
- Create: `api/_lib/redis-room-store.test.ts`

**Interfaces:**
- Produces: `RoomRecord`, `StoredPlayer`, `RoomStore`, `createRoom()`, `joinRoom()`, `leaveRoom()`, `setRoomMap()`, `startRoom()`, `touchPresence()`, and `publicRoom()`.
- `RoomStore.mutate(code, mutation)` atomically loads, changes, versions, and rewrites one room with a 7,200-second TTL.
- `RedisRoomStore.fromEnvironment()` consumes `REDIS_URL` and requires TLS outside tests.

- [ ] **Step 1: Write failing room-domain tests**

  Cover 2–4 player creation, cryptographically generated session tokens, digest-only storage, ordered colors, full-room rejection, host migration, host-only map changes, presence freshness, and start rules. Assert that starting generates one match UUID and does not expose token digests:

  ```ts
  const started = startRoom(fullRoom, hostToken, now);
  assert.equal(started.status, "starting");
  assert.match(started.matchId!, UUID_PATTERN);
  assert.equal(JSON.stringify(publicRoom(started)).includes("tokenDigest"), false);
  ```

- [ ] **Step 2: Run domain tests and confirm RED**

  Run: `node --test api/_lib/room-domain.test.ts`

  Expected: FAIL because the room domain is missing.

- [ ] **Step 3: Implement the pure domain and in-memory store**

  Use `crypto.randomUUID()`, `randomBytes(32).toString("base64url")`, and SHA-256 digests. Define `RoomStore` as:

  ```ts
  export interface RoomStore {
    create(room: RoomRecord): Promise<void>;
    get(code: string): Promise<RoomRecord | undefined>;
    mutate<T>(code: string, apply: (room: RoomRecord) => Mutation<T>): Promise<T>;
  }
  ```

  Use an injected `Clock` and token/code generators in tests. Keep every public projection exact and immutable.

- [ ] **Step 4: Write a failing Redis adapter integration test**

  When `TEST_REDIS_URL` exists, create a namespaced room, race two joins for the last slot, and assert exactly one succeeds. When it is absent, mark only this external integration test skipped; pure domain tests always run.

- [ ] **Step 5: Implement Redis atomic mutation**

  Use a Redis Lua script that compares the stored version, writes the supplied serialized record, and refreshes the TTL atomically. Retry a version conflict up to three times with a fresh read; surface a stable conflict after the third failure. Reject a non-`rediss:` production URL.

- [ ] **Step 6: Verify GREEN**

  Run: `node --test api/_lib/room-domain.test.ts api/_lib/redis-room-store.test.ts`

  Expected: pure tests pass; Redis integration passes when configured or reports one explicit skip.

- [ ] **Step 7: Commit the room domain**

  ```sh
  git add api/_lib
  git commit -m "feat: add serverless room storage"
  ```

### Task 3: Vercel room API, ETags, presence, and rate limiting

**Files:**
- Create: `api/_lib/http.ts`
- Create: `api/_lib/rate-limit.ts`
- Create: `api/_lib/rate-limit.test.ts`
- Create: `api/rooms/index.ts`
- Create: `api/rooms/[...path].ts`
- Create: `api/rooms/room-api.test.ts`
- Modify: `client/src/lobby-api.ts`
- Modify: `client/src/lobby-state.test.ts`

**Interfaces:**
- Produces same-origin routes for create, get, join, leave, map, start, and presence.
- Produces `GET /api/rooms/:code` with `ETag: "room-<version>"` and `304` support.
- Produces `POST /api/rooms/:code/presence`, authenticated by `X-Player-Token`.
- `RateLimiter.consume(scope, identity, limit, windowSeconds)` uses Redis counters with expiry.

- [ ] **Step 1: Write failing HTTP and rate-limit tests**

  Exercise handlers through exported `handleRoomRequest(request, dependencies)`. Test exact methods, status codes, body schemas, `304`, 64 KiB body rejection, invalid tokens, host-only operations, and rate-limit `429` plus `Retry-After`.

- [ ] **Step 2: Confirm RED**

  Run: `node --test api/_lib/rate-limit.test.ts api/rooms/room-api.test.ts`

  Expected: FAIL because handlers and limiter do not exist.

- [ ] **Step 3: Implement focused handlers**

  Keep Vercel entrypoints thin:

  ```ts
  export default async function handler(request: VercelRequest, response: VercelResponse) {
    return sendVercelResponse(response, await handleRoomRequest(toRequest(request), productionDependencies()));
  }
  ```

  Use exact JSON schema checks, `Cache-Control: no-store`, constant-behavior authentication, and generic external errors. Partition rate limits by trusted platform client IP and room code; never accept an arbitrary client-supplied forwarding header.

- [ ] **Step 4: Switch the client API default to same-origin**

  Set `lobbyApiUrl` to `import.meta.env.VITE_LOBBY_API_URL ?? location.origin` in browser code, while allowing an injected URL in tests. Add `presence()` and conditional `getRoom(code, etag)` methods with a typed `NotModified` result.

- [ ] **Step 5: Verify GREEN**

  Run: `npm run test:api && npm --prefix client test && npm --prefix client run typecheck`

  Expected: all API and client tests pass.

- [ ] **Step 6: Commit the room API**

  ```sh
  git add api client/src/lobby-api.ts client/src/lobby-state.test.ts
  git commit -m "feat: expose Vercel room API"
  ```

### Task 4: Conditional lobby polling transport

**Files:**
- Create: `client/src/lobby-polling.ts`
- Create: `client/src/lobby-polling.test.ts`
- Modify: `client/src/lobby-connection.ts`
- Modify: `client/src/lobby-state.test.ts`
- Modify: `client/src/lobby.ts`
- Modify: `client/package.json`

**Interfaces:**
- Produces: `LobbyPollingConnection` with the existing `connect()`, `stop()`, and handler-facing behavior used by `lobby.ts`.
- Consumes: `LobbyApi.getRoom(code, etag)` and `LobbyApi.presence(code, token)`.
- Removes the production dependency on `@microsoft/signalr`; native backend tests remain independent.

- [ ] **Step 1: Write failing polling state-machine tests**

  With a fake scheduler and fake document visibility, assert one-second visible polling, 10-second hidden polling, ETag reuse, presence refresh, recovery after transient failure, no callbacks after stop, and launch notification exactly once when a room first enters `starting`.

- [ ] **Step 2: Confirm RED**

  Run: `node --test client/src/lobby-polling.test.ts`

  Expected: FAIL because `LobbyPollingConnection` is missing.

- [ ] **Step 3: Implement the polling connection**

  Inject `setTimeout`, `clearTimeout`, and visibility state. Never overlap polls. Use capped backoff `[1_000, 2_000, 5_000, 10_000]` after failures and reset it after a successful response. Treat `304` as presence success without re-rendering.

- [ ] **Step 4: Integrate it into the lobby**

  Replace `LobbyConnection` construction with the polling implementation. Change the match callback to receive a peer launch containing `matchId`, `mapId`, ordered players, local player, and `role: "host" | "guest"`. Remove `@microsoft/signalr` after all imports are gone.

- [ ] **Step 5: Verify GREEN**

  Run: `npm --prefix client test && npm --prefix client run typecheck`

  Expected: all lobby behavior passes without SignalR.

- [ ] **Step 6: Commit polling**

  ```sh
  git add client
  git commit -m "feat: poll Vercel lobby state"
  ```

### Task 5: Authenticated Redis signaling API

**Files:**
- Create: `shared/signaling-contract.ts`
- Create: `shared/signaling-contract.test.ts`
- Create: `api/_lib/signal-store.ts`
- Create: `api/_lib/memory-signal-store.ts`
- Create: `api/_lib/redis-signal-store.ts`
- Create: `api/rooms/signaling-api.test.ts`
- Modify: `api/rooms/[...path].ts`

**Interfaces:**
- Produces: `SignalEnvelope` types for `offer`, `answer`, `candidate`, `ready`, and `failed`.
- Produces: authenticated signal POST and cursor-based GET routes.
- `SignalStore.append(code, recipientId, envelope)` returns a monotonically increasing cursor.
- `SignalStore.read(code, recipientId, after, limit)` returns at most 64 envelopes.

- [ ] **Step 1: Write failing signaling schema tests**

  Reject unknown keys, messages over 16 KiB, invalid SDP types, ICE candidates over 4 KiB, a sender targeting itself, non-members, and cursor manipulation. Assert the public response never includes token digests.

- [ ] **Step 2: Confirm RED**

  Run: `node --test shared/signaling-contract.test.ts api/rooms/signaling-api.test.ts`

  Expected: FAIL because signaling contracts and handlers are missing.

- [ ] **Step 3: Implement store and handlers**

  Use per-recipient Redis streams named from a keyed SHA-256 room identifier, not raw tokens. Set the stream TTL to the remaining room TTL. Authenticate before parsing recipient-specific state. Apply separate write and poll rate-limit scopes.

- [ ] **Step 4: Verify GREEN**

  Run: `npm run test:api`

  Expected: all shared, room, rate-limit, and signaling tests pass.

- [ ] **Step 5: Commit signaling**

  ```sh
  git add shared api
  git commit -m "feat: add WebRTC signaling API"
  ```

### Task 6: Peer wire codec and WebRTC mesh

**Files:**
- Create: `client/src/peer-protocol.ts`
- Create: `client/src/peer-protocol.test.ts`
- Create: `client/src/signaling-client.ts`
- Create: `client/src/signaling-client.test.ts`
- Create: `client/src/peer-mesh.ts`
- Create: `client/src/peer-mesh.test.ts`

**Interfaces:**
- Produces: `encodePeerMessage()`, `parsePeerMessage()`, `HostPeerMesh`, and `GuestPeerConnection`.
- Control messages: protocol version, identity, map, readiness, completion, failure.
- Input messages: existing `ClientInput` plus authenticated player identity inferred from the channel.
- Snapshot messages: existing validated `ServerSnapshot` encoded as UTF-8 bytes in an `ArrayBuffer`.

- [ ] **Step 1: Write failing codec tests**

  Assert binary round trips, exact message keys, 512-byte input cap, 256 KiB snapshot cap, invalid UTF-8 rejection, stale sequence rejection, and protocol-version mismatch.

- [ ] **Step 2: Confirm codec RED**

  Run: `node --test client/src/peer-protocol.test.ts`

  Expected: FAIL because the codec is missing.

- [ ] **Step 3: Implement the bounded codec**

  Prefix every payload with one byte identifying control, input, or snapshot; encode the validated JSON body with `TextEncoder`. Decode with fatal UTF-8 handling and feed snapshots through the existing `parseServerMessage()` boundary.

- [ ] **Step 4: Write failing peer-mesh tests**

  Use a small fake `RTCPeerConnection`/data-channel adapter. Assert one connection per guest, correct ordered/reliable settings for `control`, unordered `maxRetransmits: 0` for `input` and `snapshot`, identity binding, readiness only after all three channels open, neutral input on disconnect, 15-second negotiation timeout, and one bounded ICE restart.

- [ ] **Step 5: Implement signaling client and mesh**

  Inject WebRTC constructors and timers. The signaling client polls with a cursor and posts exact envelopes. Use `stun:stun.cloudflare.com:3478` as the sole default ICE server and provide no TURN URL. The mesh never accepts a player ID from an input payload; it associates the data channel with the room member established by authenticated signaling.

- [ ] **Step 6: Verify GREEN**

  Run: `node --test client/src/peer-protocol.test.ts client/src/signaling-client.test.ts client/src/peer-mesh.test.ts && npm --prefix client run typecheck`

  Expected: codec, signaling, and mesh tests pass.

- [ ] **Step 7: Commit peer networking**

  ```sh
  git add client/src/peer-*.ts client/src/signaling-client*.ts
  git commit -m "feat: connect players with WebRTC"
  ```

### Task 7: Deterministic WebAssembly simulation target

**Files:**
- Create: `simulation/wasm/CMakeLists.txt`
- Create: `simulation/wasm/wasm_bridge.cpp`
- Create: `simulation/wasm/wasm_bridge_test.mjs`
- Create: `scripts/build-wasm.sh`
- Create: `client/src/wasm/linked-up-simulation.js`
- Create: `client/src/wasm/linked-up-simulation.wasm`
- Create: `client/src/wasm/source-manifest.json`
- Modify: `.gitignore`
- Modify: `simulation/tests/prototype_simulation_test.cpp`

**Interfaces:**
- Produces Emscripten module functions `_lu_create`, `_lu_set_input`, `_lu_step`, `_lu_snapshot`, and `_lu_destroy`.
- `_lu_snapshot()` returns a pointer to module-owned UTF-8 JSON valid until the next bridge call.
- Uses the existing `route_config()` and `PrototypeSimulation` sources directly.

- [ ] **Step 1: Add the failing native parity fixture**

  Extend the native test executable with a deterministic fixture that loads each map, applies a fixed 240-tick input sequence for rosters of two, three, and four, and emits normalized snapshot JSON when invoked with `--parity-fixture`.

- [ ] **Step 2: Run the native fixture and confirm the Wasm comparison is RED**

  Run: `cmake --build build -j 4 && node simulation/wasm/wasm_bridge_test.mjs`

  Expected: FAIL because the Wasm module and bridge do not exist.

- [ ] **Step 3: Add the isolated Emscripten build**

  Fetch pinned Jolt `v5.6.0`, enable `CROSS_PLATFORM_DETERMINISTIC`, and compile only `prototype_simulation.cpp` plus `wasm_bridge.cpp`. Export the five bridge functions, `ccall`, and `UTF8ToString`; use `MODULARIZE=1`, `EXPORT_ES6=1`, `ALLOW_MEMORY_GROWTH=1`, and no filesystem.

- [ ] **Step 4: Implement the bridge**

  Validate map IDs, roster size/uniqueness, player index, finite axes in `[-1,1]`, and increasing sequences. Maintain acknowledged sequences beside `PrototypeSimulation`. Serialize the same snapshot fields and enum names accepted by `client/src/gameplay-protocol.ts`.

- [ ] **Step 5: Build and commit deterministic artifacts**

  `scripts/build-wasm.sh` runs `emcmake cmake`, builds Release, copies the JS/Wasm pair, and writes SHA-256 hashes of `prototype_simulation.cpp`, its header, the bridge, CMake file, and Jolt tag to `source-manifest.json`. Generated artifacts are intentionally tracked; transient `build-wasm/` remains ignored.

- [ ] **Step 6: Verify native/Wasm parity GREEN**

  Run: `scripts/build-wasm.sh && node simulation/wasm/wasm_bridge_test.mjs && ctest --test-dir build --output-on-failure`

  Expected: every normalized fixture matches and all native tests pass.

- [ ] **Step 7: Commit the Wasm target**

  ```sh
  git add -f simulation/wasm scripts/build-wasm.sh client/src/wasm .gitignore simulation/tests/prototype_simulation_test.cpp
  git commit -m "feat: compile authoritative simulation to Wasm"
  ```

### Task 8: Simulation Web Worker and host clock

**Files:**
- Create: `client/src/simulation-worker-protocol.ts`
- Create: `client/src/simulation-worker-protocol.test.ts`
- Create: `client/src/simulation-worker.ts`
- Create: `client/src/host-simulation.ts`
- Create: `client/src/host-simulation.test.ts`

**Interfaces:**
- Produces: `HostSimulation.create(mapId, roster, handlers)`, `setInput(player, input)`, and `dispose()`.
- Worker commands: `initialize`, `input`, `advance`, and `dispose`.
- Worker events: `ready`, `snapshot`, `finished`, and `error`.

- [ ] **Step 1: Write failing worker protocol and clock tests**

  Assert exact message schemas, a 60 Hz fixed step, snapshots every third tick, monotonic accumulation, at most eight catch-up steps after a stall, no callbacks after disposal, and stable initialization errors.

- [ ] **Step 2: Confirm RED**

  Run: `node --test client/src/simulation-worker-protocol.test.ts client/src/host-simulation.test.ts`

  Expected: FAIL because worker runtime modules are missing.

- [ ] **Step 3: Implement the worker and host facade**

  Load the generated Wasm module only in the worker. Drive `advance` from a monotonic host clock, never from wall-clock dates. Parse every Wasm snapshot with the existing server-message validator before forwarding it to the renderer or peers.

- [ ] **Step 4: Verify GREEN**

  Run: `node --test client/src/simulation-worker-protocol.test.ts client/src/host-simulation.test.ts && npm --prefix client run typecheck && npm --prefix client run build`

  Expected: tests, typecheck, worker bundling, and production build pass.

- [ ] **Step 5: Commit the host simulation**

  ```sh
  git add client/src/simulation-worker* client/src/host-simulation*
  git commit -m "feat: run matches in host browser"
  ```

### Task 9: Host/guest gameplay integration

**Files:**
- Create: `client/src/peer-gameplay-connection.ts`
- Create: `client/src/peer-gameplay-connection.test.ts`
- Create: `client/src/match-orchestrator.ts`
- Create: `client/src/match-orchestrator.test.ts`
- Modify: `client/src/game.ts`
- Modify: `client/src/main.ts`
- Modify: `client/src/lobby.ts`
- Modify: `client/src/match-launch.ts`
- Modify: `client/src/match-launch.test.ts`

**Interfaces:**
- Produces a `GameplayTransport` interface implemented by native `GameplayConnection` and peer `PeerGameplayConnection`.
- Produces `MatchOrchestrator.start(launch, session)` that selects host or guest behavior.
- Host snapshots feed its local renderer and every guest; guest inputs go only to the host.

- [ ] **Step 1: Write failing transport/orchestrator tests**

  Assert host worker creation with the selected map and ordered roster, guest offer answering, countdown only after all peers are ready, input routing by role, snapshot fan-out, completion fan-out, neutral input on guest loss, and match termination on host loss.

- [ ] **Step 2: Confirm RED**

  Run: `node --test client/src/peer-gameplay-connection.test.ts client/src/match-orchestrator.test.ts`

  Expected: FAIL because peer gameplay integration is missing.

- [ ] **Step 3: Extract the gameplay transport boundary**

  Change `Game.create()` to consume a `GameplayTransport` rather than constructing a WebSocket itself. Keep the native transport behavior intact for Vite development tests.

- [ ] **Step 4: Implement host and guest orchestration**

  Host: initialize Wasm, establish peers, mark ready, run countdown, route inputs, and broadcast snapshots. Guest: negotiate, wait for host readiness, run synchronized countdown, send inputs, and validate snapshots. Include protocol version `1` in room launch and control handshakes.

- [ ] **Step 5: Verify GREEN**

  Run: `npm --prefix client test && npm --prefix client run typecheck && npm --prefix client run build`

  Expected: all client tests and the production build pass.

- [ ] **Step 6: Commit gameplay integration**

  ```sh
  git add client/src
  git commit -m "feat: launch peer-hosted matches"
  ```

### Task 10: Production safeguards and failure UI

**Files:**
- Create: `client/src/runtime-mode.ts`
- Create: `client/src/runtime-mode.test.ts`
- Create: `client/src/peer-status.ts`
- Create: `client/src/peer-status.test.ts`
- Modify: `client/index.html`
- Modify: `client/src/main.ts`
- Modify: `client/src/lobby.ts`
- Modify: `client/src/styles.css`
- Modify: `api/_lib/http.ts`

**Interfaces:**
- Produces: `isNativeDevelopmentMode(importMetaEnv)`, `peerFailureMessage(reason)`, and production response headers.
- Production UI discloses host authority and no-TURN network limitations before room creation.

- [ ] **Step 1: Write failing runtime and copy tests**

  Assert that `?player=` is honored only when `DEV === true`, production always renders the lobby, restrictive-network and host-loss failures have distinct copy, and no error includes a token, SDP, or ICE candidate.

- [ ] **Step 2: Confirm RED**

  Run: `node --test client/src/runtime-mode.test.ts client/src/peer-status.test.ts`

  Expected: FAIL because runtime policy and peer status mapping are missing.

- [ ] **Step 3: Implement safeguards and UI**

  Add concise lobby disclosure, negotiation progress, retry/leave actions, host-left handling, unsupported-WebAssembly/WebRTC handling, and hidden-tab host warning. Add CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and frame-denial headers without blocking Wasm workers or STUN/WebRTC.

- [ ] **Step 4: Verify production bypass absence**

  Run: `npm --prefix client run build && ! rg -n "ws://127.0.0.1:9002|player=blue|player=orange" client/dist`

  Expected: build passes and the search finds no production bypass strings.

- [ ] **Step 5: Run all client/API tests**

  Run: `npm run test:api && npm --prefix client test && npm --prefix client run typecheck`

  Expected: all tests pass.

- [ ] **Step 6: Commit safeguards**

  ```sh
  git add client api/_lib/http.ts
  git commit -m "feat: harden peer-hosted alpha"
  ```

### Task 11: Vercel configuration and local deployment emulation

**Files:**
- Create: `vercel.json`
- Create: `.env.example`
- Create: `scripts/verify-vercel-build.mjs`
- Create: `scripts/verify-vercel-build.test.mjs`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/networking.md`

**Interfaces:**
- Produces one Vercel project with static SPA output and `/api` Functions.
- Documents only `REDIS_URL` as a required production secret; Redis integration supplies it.

- [ ] **Step 1: Write the failing deployment-config verifier**

  Assert that `vercel.json` builds from the root, outputs `client/dist`, preserves `/api`, rewrites other paths to `/index.html`, sets immutable Wasm/assets caching, and contains required security headers. Assert `.env.example` contains names but no credential values.

- [ ] **Step 2: Confirm RED**

  Run: `node --test scripts/verify-vercel-build.test.mjs`

  Expected: FAIL because the Vercel configuration is absent.

- [ ] **Step 3: Add Vercel and documentation configuration**

  Use a catch-all SPA rewrite that excludes `/api`, `/assets`, and the Wasm asset. Configure Function source under `api/`. Update architecture and networking docs to distinguish native local mode from Vercel peer-hosted production mode and state every accepted limitation.

- [ ] **Step 4: Verify local Vercel build**

  Run: `vercel build --yes`

  Expected: Vercel detects static output and Functions, builds successfully, and creates `.vercel/output` without embedding secrets.

- [ ] **Step 5: Run artifact verification**

  Run: `node scripts/verify-vercel-build.mjs .vercel/output`

  Expected: SPA route, API Functions, security headers, Wasm MIME type, and absence of native bypass strings all pass.

- [ ] **Step 6: Commit deployment configuration**

  ```sh
  git add vercel.json .env.example scripts .gitignore README.md docs
  git commit -m "build: prepare Vercel public alpha"
  ```

### Task 12: Full verification, preview deployment, and production promotion

**Files:**
- Create: `scripts/deployed-smoke.mjs`
- Create: `docs/deployment.md`
- Modify: `README.md`

**Interfaces:**
- `scripts/deployed-smoke.mjs <base-url>` verifies landing, deep room route, create/join/map/start/signaling authorization, and security headers without logging tokens.
- `docs/deployment.md` records login, free Redis installation, preview, promotion, rollback, usage checks, and the external-network playtest.

- [ ] **Step 1: Write and run a failing deployed-smoke self-test**

  Test the smoke script against a local fake server containing one intentionally missing header. Confirm it fails on that header, then make the fixture complete and confirm it passes.

- [ ] **Step 2: Run the complete local verification matrix**

  Run:

  ```sh
  npm run test
  npm --prefix client run typecheck
  npm --prefix client run build
  cmake --build build -j 4
  ctest --test-dir build --output-on-failure
  node simulation/wasm/wasm_bridge_test.mjs
  vercel build --yes
  node scripts/verify-vercel-build.mjs .vercel/output
  ```

  Expected: every command exits zero with no failed tests.

- [ ] **Step 3: Complete user-owned Vercel setup**

  The user runs `vercel login`, selects the personal Hobby account, and approves the project name. Install the free Redis integration with `vc i redis/redis`, connect it to this project, and verify `REDIS_URL` exists for Preview and Production without printing its value.

- [ ] **Step 4: Deploy and smoke-test Preview**

  Run: `vercel deploy`

  Capture the returned Preview URL, then run `node scripts/deployed-smoke.mjs <preview-url>`. Inspect runtime logs by request ID and confirm no token, SDP body, or ICE candidate appears.

- [ ] **Step 5: Run browser multiplayer verification**

  Use two, three, and four isolated browser contexts. For every map, verify host-only selection, room polling, peer negotiation, countdown, player movement, obstacle rendering, checkpoint updates, and completion. Repeat one two-player match from two ordinary external networks. Record restrictive-network failure honestly if direct ICE cannot connect.

- [ ] **Step 6: Promote the verified deployment**

  Run: `vercel promote <preview-url>`

  Run `node scripts/deployed-smoke.mjs <production-url>` and one final two-player browser match. Check the Vercel usage dashboard and confirm Hobby usage remains within included limits.

- [ ] **Step 7: Commit deployment runbook and final verifier**

  ```sh
  git add scripts/deployed-smoke.mjs docs/deployment.md README.md
  git commit -m "docs: add Vercel alpha runbook"
  ```

- [ ] **Step 8: Completion audit**

  Re-read the approved spec requirement by requirement. Link each requirement to a passing test, built artifact, deployed response, browser observation, or documented accepted limitation. Do not mark the public alpha complete if any required evidence is missing.
