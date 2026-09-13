# Linked-Up

Linked-Up is a 2–4 player cooperative browser climbing game. Small robots share an energy tether, so a jump, fall, or rescue affects the whole team. The host chooses one of four maps in the lobby: Classic Ascent, Relay Ridge, Crane Shift, or Windworks.

## Public-alpha architecture

The deployable version runs as one Vercel project:

```text
Browser ── HTTPS room + signaling requests ──> Vercel Functions ──> Redis
Host browser ── WebRTC DataChannels ──> guest browsers
Host Web Worker ── WebAssembly/Jolt ──> authoritative snapshots at 20 Hz
```

- Vercel serves the Babylon.js client and short-lived room/signaling Functions.
- Redis stores expiring room membership, token digests, and temporary signaling mailboxes.
- The room host runs the authoritative 60 Hz C++/Jolt simulation compiled to WebAssembly.
- Guests send input only to the host and render validated host snapshots.
- The production build contains no loopback gameplay bypass.

This keeps the alpha on Vercel's Hobby-compatible request model: no permanent game server and no long-running Vercel Function. Direct WebRTC has no TURN relay, so restrictive VPN, school, workplace, carrier, or symmetric-NAT combinations may fail to connect. The lobby tells players this before room creation.

The public alpha is live at [vercel-public-alpha-three.vercel.app](https://vercel-public-alpha-three.vercel.app).

See the [deployment runbook](docs/deployment.md), [architecture](docs/architecture.md), [networking](docs/networking.md), and [game design](docs/game-design.md).

## Deploy prerequisites

- Node.js 20.19 or newer
- A Vercel personal Hobby account
- Vercel CLI
- A free Redis integration connected to the Vercel project
- `REDIS_URL` enabled for Preview and Production

Install and verify locally:

```sh
npm ci
npm --prefix client ci
npm test
npm --prefix client run typecheck
npm run build
node scripts/verify-vercel-build.mjs
```

Build the Vercel artifact with `vercel build --yes`, then verify it with:

```sh
node scripts/verify-vercel-build.mjs .vercel/output
```

`.env.example` names the only required runtime secret. Never commit the Redis value.

## Local browser development

Run the Vite client with `npm --prefix client run dev`. Production room APIs require Redis and are best exercised with Vercel's local emulator after linking the project and pulling Development environment variables.

The repository retains the older native stack for simulation development. In a Vite development build only, `?player=blue` and `?player=orange` can connect to the loopback C++ server at `127.0.0.1:9002`. Vite removes this branch and its URLs from production output.

To rebuild the browser simulation, install Emscripten and run `scripts/build-wasm.sh`. It pins Jolt Physics `v5.6.0`, generates the committed JavaScript/Wasm artifacts, builds a native parity fixture from the same source, and records source hashes.

## Verification

- API/shared tests: `npm run test:api`
- Client tests: `npm --prefix client test`
- Type check: `npm --prefix client run typecheck`
- Wasm/native parity: `node simulation/wasm/wasm_bridge_test.mjs`
- Vercel config/artifact: `node --test scripts/verify-vercel-build.test.mjs`
- Deployed room lifecycle: `node scripts/deployed-smoke.mjs https://your-deployment.example`

The Redis concurrency test runs when `TEST_REDIS_URL` is set; otherwise it is reported as skipped.
