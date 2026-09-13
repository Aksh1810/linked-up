# Vercel-Only Public Alpha Design

## Status

Approved architecture: the public alpha runs on the Vercel Hobby plan without
Railway, Fly.io, or another always-on application server. Vercel serves the Vite
client and short-lived TypeScript Functions. Redis for Vercel stores temporary
rooms and WebRTC signaling. The host player's browser runs the authoritative C++
simulation compiled to WebAssembly.

This is a personal, non-commercial alpha. It deliberately accepts the
reliability and trust limitations of free peer-to-peer networking.

## Goals

- Let two to four users on different networks create, join, select a map, and
  complete a match through one public Vercel URL.
- Preserve the existing Jolt-based C++ physics and authored maps by compiling
  the simulation core to WebAssembly.
- Require no paid or continuously running server.
- Keep room credentials out of public room state, URLs, and normal logs.
- Keep local native server development available while production uses WebRTC.
- Fit normal small personal playtests within Vercel Hobby usage limits.

## Accepted limitations

- The room host is authoritative and can manipulate local match state.
- The match ends if the host closes, reloads, sleeps, or loses connectivity.
- Some school, office, carrier-grade NAT, VPN, or restrictive mobile networks
  will fail to establish peer-to-peer connectivity because the free design has
  STUN but no TURN relay.
- The host must keep the game tab open and the device awake during a match.
- Lobby state is temporary and expires after two hours.
- The design is for personal, non-commercial use under Vercel Hobby terms.
- A larger public or commercial release will require paid relay and persistent
  authoritative game-server infrastructure.

## Architecture

```text
Browser ---------------- HTTPS ----------------> Vercel Vite client
Browser -- short HTTPS requests and polling --> Vercel Functions
Vercel Functions ---------- Redis -----------> Redis for Vercel

Host browser
  |-- C++/Jolt simulation compiled to WebAssembly in a Web Worker
  |-- local input ----------------------------> authoritative simulation
  `-- WebRTC data channels <-----------------> guest browsers

Guest browsers
  |-- input intents --------------------------> host browser
  `-- snapshots <----------------------------- host browser
```

Vercel Functions own temporary lobby rules and WebRTC signaling but never run a
simulation loop or hold a long connection. Functions are stateless between
requests. Redis is the source of truth for rooms, hashed room-session tokens,
rate-limit counters, and short-lived signaling envelopes.

The host runs one deterministic simulation inside a dedicated Web Worker. Each
guest has a direct WebRTC connection to the host. Guests send input intent; the
host applies every player's intent at 60 Hz and broadcasts authoritative
snapshots at 20 Hz. The existing browser interpolation and local prediction
continue to consume the snapshot protocol.

## Vercel deployment

The repository root is the Vercel project root. `vercel.json` defines:

- the client build command and `client/dist` output;
- SPA fallback routing for `/room/:code`;
- `/api/*` TypeScript Functions;
- immutable caching for hashed assets and the WebAssembly binary;
- security headers compatible with Babylon.js, WebAssembly, and WebRTC.

All browser API calls use same-origin `/api` paths. No production hostname is
compiled into the client, so preview and production deployments work without
CORS configuration.

The direct native `?player=` development bypass is available only under Vite
development mode. Production builds ignore it and always use the lobby.

## Serverless lobby

The production lobby is implemented in focused TypeScript modules shared by
Vercel Functions. It preserves the existing public room contract and rules:

- capacities of two to four;
- unambiguous four-character room codes;
- ordered Blue, Orange, Green, and Purple slots;
- host-only map selection and start;
- host migration while waiting;
- start only when all slots are occupied and recently present;
- selected map included in the immutable match launch;
- two-hour sliding room expiry.

Each create or join response includes an opaque per-player session token. The
browser stores it in `sessionStorage`; Redis stores only its SHA-256 digest.
Authenticated mutations send the token in `X-Player-Token`, never in a URL.

Lobby clients poll room state with conditional requests. Responses carry the
room version as an ETag, and unchanged polls return `304`. Waiting clients poll
once per second while visible and back off while hidden. Presence is a Redis
timestamp refreshed by polling rather than an in-process SignalR connection.

Redis transactions or Lua scripts make room creation, joining, leaving, host
migration, map changes, and transition to `starting` atomic. A start operation
creates a match identifier and changes the room to `starting`; the host begins
WebRTC negotiation. The room becomes `inGame` after every guest has confirmed
its control and snapshot channels.

## WebRTC signaling

Vercel Functions exchange opaque signaling envelopes through Redis:

- `POST /api/rooms/:code/signals` appends an authenticated offer, answer, ICE
  candidate, readiness, or failure envelope for one recipient.
- `GET /api/rooms/:code/signals?after=:cursor` returns only envelopes addressed
  to the authenticated player after the supplied cursor.
- Signaling entries expire with the room and are deleted once acknowledged.

Payloads have strict schemas and size limits. A player can send only signaling
messages for its own room identity and only to another current room member.
Rate limits prevent signaling amplification.

The host creates one `RTCPeerConnection` per guest. Each connection has:

- a reliable ordered `control` data channel for identity, map, readiness,
  completion, and errors;
- a low-latency unordered `input` channel for guest input intents;
- a low-latency unordered `snapshot` channel for authoritative snapshots.

Inputs and snapshots use bounded binary messages rather than JSON once the
connection is established. Control messages remain small validated JSON.
Signaling uses a configurable STUN server list, defaults to
`stun:stun.cloudflare.com:3478`, and has no TURN credentials in the free alpha.
A connection timeout produces a clear message explaining that the network may
not support direct peer-to-peer play.

## WebAssembly simulation

A new Emscripten build target contains only `PrototypeSimulation`, authored
route data, Jolt Physics, and a narrow C ABI wrapper. It excludes Crow, gRPC,
protobuf, OpenSSL, the native match manager, and native server entrypoints.

The wrapper owns one match and exposes operations equivalent to:

```text
create(map_id, ordered_roster)
set_input(player_index, sequence, move_x, move_z, jump)
step()
snapshot_size()
write_snapshot(destination, capacity)
destroy()
```

The worker loads the WebAssembly module, creates the selected route, accepts
validated input messages from the UI and peer layer, and advances with a
monotonic accumulator. It caps catch-up work after a stalled tab to protect the
browser. Snapshots retain the existing wire semantics: tick, acknowledgements,
players, tether tension, match state, checkpoints, and obstacle transforms.

Native and WebAssembly builds use Jolt's cross-platform deterministic option and
the same route/configuration source. A parity fixture feeds both builds an
identical roster and input sequence and compares normalized snapshots at fixed
ticks. The native C++ server remains the local reference implementation and can
still be run for development tests.

## Host and guest runtime flow

### Host

1. Create a room and retain the room session token in the current tab.
2. Select a map and wait for every slot to be present.
3. Start the room, load the simulation worker, and create a peer connection for
   every guest.
4. Exchange signaling through short Vercel Function requests.
5. Start the countdown after every data channel is ready.
6. Apply local and remote input intents to the worker.
7. Broadcast snapshots and completion over peer data channels.
8. Stop the match if the host page exits or a required peer cannot reconnect.

### Guest

1. Join through the invite URL and retain its private room token in the tab.
2. Observe map and roster changes through conditional lobby polling.
3. Answer the host's WebRTC offer through signaling Functions.
4. Send input intent to the host and render received snapshots.
5. Attempt bounded ICE restart after a transient peer disconnection.
6. Return to the lobby with a clear explanation if recovery fails.

## Security and abuse controls

- Room and signaling tokens never appear in URLs, fragments, Redis plaintext,
  public state, analytics, or application logs.
- Every private token is generated from cryptographically secure random bytes,
  stored only as a digest server-side, and compared without early exit.
- Per-IP and per-room Redis counters limit creates, joins, lookups, mutations,
  signaling writes, and signaling polls.
- API request bodies and peer messages have explicit byte limits and exact
  schemas; unknown fields are rejected.
- ICE candidates are visible only to authenticated participants in that room.
- Security headers deny framing and MIME sniffing and set a restrictive
  referrer policy and content security policy.
- The host validates input axes, sequence ordering, and message frequency before
  applying guest input.
- Guests validate every host snapshot before rendering it.
- Redis credentials exist only in Vercel environment variables.
- Production does not expose native-server bypasses or debug panels containing
  credentials.

Host authority is a documented trust limitation, not an anti-cheat boundary.

## Failure behavior

- Redis unavailable: Functions return a stable service-unavailable response;
  existing peer matches continue because gameplay is browser-to-browser.
- Signaling timeout: participants stay in the lobby and receive a direct-network
  failure message.
- Guest disconnect: the host neutralizes that player's input immediately and
  attempts a bounded ICE restart.
- Host disconnect, reload, sleep, or close: the match ends for all guests.
- Wasm initialization failure: start returns the room to waiting and shows a
  browser compatibility message.
- Vercel usage limit reached: new lobby requests may fail; clients display a
  temporary capacity message rather than looping.
- Deployment during a match: loaded static assets and peer gameplay continue,
  but signaling recovery may fail if protocol versions differ. A protocol
  version is included in room and peer handshakes to fail clearly.

## Zero-cost guardrails

- Deploy under a Vercel Hobby account for personal, non-commercial use.
- Use Redis for Vercel's free plan and configure short TTLs for every key.
- Use short Functions only; no WebSocket Function, simulation loop, cron loop,
  proxy, or limit-circumvention mechanism is introduced.
- Poll only while a lobby or negotiation screen is active, use ETags, and back
  off hidden tabs.
- Do not configure a paid TURN relay. The UI discloses reduced network
  compatibility before room creation.
- Enable Vercel usage notifications and inspect usage during the alpha.

## Verification

Repository verification must include:

- all existing native C++, backend, and client suites;
- TypeScript tests for every serverless room and signaling transition;
- tests proving tokens remain out of URLs, public state, and logs;
- rate-limit and malformed-payload tests;
- native/Wasm deterministic parity fixtures for all four maps and rosters of
  two, three, and four players;
- worker timing, catch-up cap, and lifecycle tests;
- peer protocol validation and disconnect tests;
- browser tests with two to four isolated contexts covering lobby, host-only map
  selection, negotiation, countdown, gameplay, checkpoint, and completion;
- production-build checks proving the local bypass is absent;
- Vercel preview smoke tests for SPA invite routes and every API endpoint;
- a deployed test between two ordinary external networks;
- confirmation that no credential appears in Vercel runtime logs.

The alpha is releasable only after the full verification set passes. A failed
restrictive-network test is documented as the accepted no-TURN limitation, not
silently treated as a working connection.

## User-owned account steps

The user performs only actions requiring account ownership or interactive
authentication:

1. Run `vercel login` and choose the personal Hobby account that will own the
   project.
2. Confirm the project is personal and non-commercial under Hobby terms.
3. Approve the Vercel project name when the prepared repository is linked.
4. Install the free Redis for Vercel integration when prompted and connect it to
   the project; no paid plan is selected.
5. Approve the first production deployment after the preview verification
   passes.

No deployment secret is pasted into chat or committed to Git.

## Delivery sequence

1. Replace the previous server-hosted deployment assumptions with this design.
2. Implement and parity-test the WebAssembly simulation target.
3. Implement the Web Worker host runtime and peer protocol.
4. Implement serverless lobby and signaling Functions backed by Redis.
5. Replace production SignalR/gameplay WebSocket flow with WebRTC while
   retaining native local development.
6. Add security, rate limiting, zero-cost polling controls, and failure UI.
7. Add Vercel build, routing, headers, and environment configuration.
8. Run the complete native, Wasm, Function, client, and browser verification.
9. Perform the user-owned Vercel login and free Redis installation.
10. Deploy a preview, verify it, promote it, and run external-network playtests.
