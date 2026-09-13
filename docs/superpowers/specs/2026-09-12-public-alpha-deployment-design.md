# Public Alpha Deployment Design

## Status

Approved architecture: Vercel hosts the public browser client. Fly.io hosts the
persistent ASP.NET Core lobby and C++ authoritative simulation. Railway is not
used. A managed Upstash Redis database stores temporary room state.

This design targets a public multiplayer alpha. It does not claim durable match
recovery or horizontal game-server scaling.

## Goals

- Let two to four users on different networks create, join, select a map, and
  complete a match through public HTTPS links.
- Preserve the existing authoritative C++ simulation and ASP.NET Core lobby.
- Use Vercel for the public Vite client and invite routes.
- Keep Redis and lobby-to-simulation traffic off the public Internet.
- Ensure private admission credentials do not appear in URLs or normal logs.
- Provide repeatable builds, health checks, smoke tests, and deployment steps.

## Non-goals

- Accounts, matchmaking, progression, chat, payments, or persistent history.
- Surviving a simulation deployment or crash without ending active matches.
- Multiple API or simulation replicas in the initial alpha.
- Multi-region matchmaking or match migration.
- Replacing the existing C++ physics implementation with serverless code.

## Architecture

```text
Browser
  |-- HTTPS ----------> Vercel Vite client
  |-- HTTPS/SignalR --> Fly.io lobby API
  `-- WSS ------------> Fly.io C++ simulation

Fly.io lobby API
  |-- TLS ------------> Upstash Redis
  `-- private h2c ----> Fly.io C++ simulation:50051
```

The frontend has one stable Vercel production URL. The lobby API and simulation
each have a stable Fly.io public hostname. The browser reaches the lobby over
HTTPS and the simulation over WSS. Only the lobby reaches the coordination gRPC
port, using Fly.io private DNS. Redis accepts TLS-authenticated traffic from the
lobby and is never called by browsers.

The initial release runs exactly one lobby Machine and one simulation Machine in
the same Fly.io region. Auto-stop is disabled for both. This preserves the
current in-process lobby presence and in-memory match ownership assumptions.

## Deployment units

### Vercel client

The Vercel project builds `client/` with `npm run build` and serves `client/dist`.
A SPA rewrite sends all non-asset paths, including `/room/:code`, to
`index.html`. `VITE_LOBBY_API_URL` is set at build time to the Fly.io lobby URL.
The direct `?player=` development bypass is unavailable in production builds.

### Fly.io lobby API

A multi-stage Dockerfile builds and publishes the ASP.NET Core API. The runtime
listens on `0.0.0.0` at its configured HTTP port. Configuration is supplied only
through environment variables or Fly secrets:

- `LinkedUp__ClientOrigin`: exact stable Vercel production origin.
- `LinkedUp__Redis`: Upstash Redis TLS connection configuration.
- `Simulation__Address`: private h2c address for the simulation service.
- `ASPNETCORE_URLS`: public HTTP listener inside the Machine.

The API exposes `/health/live` and `/health/ready`. Fly.io uses readiness for its
health check. CORS allows credentials only from the exact Vercel production
origin.

### Fly.io authoritative simulation

A multi-stage Dockerfile builds the C++ server and copies only its runtime
binary and required shared libraries into the final image. Runtime settings
replace compile-time loopback assumptions:

- public gameplay bind address and port;
- private coordination bind address and port;
- public `wss://` gameplay URL returned to the lobby;
- production flag controlling the local development bypass.

The gameplay listener binds publicly inside the Machine. The gRPC coordination
listener is reachable only over Fly.io private networking. `/health` is the
public health-check endpoint. Auto-stop is disabled because active matches and
fixed simulation ticks live in process memory.

### Managed Redis

An Upstash Redis database is provisioned through the Vercel Marketplace or
Upstash console. The lobby uses its TLS endpoint and password. Redis stores only
temporary rooms, hashed lobby session tokens, and their existing TTLs. Raw game
tickets and snapshots remain outside Redis.

## Production networking changes

Local defaults remain unchanged for developers, but every public address and
bind address becomes configuration-driven. Startup fails with a clear message
when production mode receives a loopback public gameplay URL, a non-TLS Redis
connection, or an HTTP/WSS mismatch.

The client accepts HTTPS lobby URLs and WSS gameplay URLs in production. Mixed
content is rejected before attempting a connection. The server trusts only the
configured client origin. No wildcard CORS origin is introduced.

## WebSocket admission and reconnection

The current query-string ticket transport is replaced for normal matches.
The browser opens the clean `/game` WSS endpoint and immediately sends:

```json
{"type":"authenticate","matchId":"...","ticket":"..."}
```

Until authentication succeeds, the connection cannot send inputs or receive
match snapshots. Authentication has a short timeout and stable error messages.
The server stores only credential digests and never logs the authentication
payload. This prevents edge proxies and access logs from recording tickets in
request URLs.

After admission, the server returns an opaque resume credential in the welcome
message. The browser retains it only in memory and reconnects with bounded
exponential backoff after a transient disconnect. Successful resumption rotates
the credential. Resume credentials expire when the match expires or completes.
A page reload does not resume the match in the initial alpha.

The loopback-only development bypass may retain its current query parameter,
but it is compiled or configured out of production.

## Abuse controls and security

- Apply per-IP rate limits to room creation, room lookup, join, map change, and
  start operations. Existing authenticated room semantics still apply.
- Retain the C++ input size, validation, ordering, and 120-message-per-second
  limits.
- Reject untrusted forwarded headers unless they came through the known platform
  proxy configuration.
- Do not include session tokens, tickets, resume credentials, Redis credentials,
  or full WebSocket URLs with secrets in logs.
- Run containers as non-root users with read-only application filesystems where
  the runtime permits it.
- Pin build dependencies and produce deterministic release builds.
- Keep the gRPC coordination port private and Redis authenticated with TLS.

## Failure behavior

- Redis unavailable: lobby readiness is unhealthy; room mutations return the
  existing service-unavailable response.
- Simulation unavailable: starting rolls the room back to waiting, as it does
  locally.
- Browser loses lobby before start: SignalR reconnects and resubscribes with the
  existing room token.
- Browser loses gameplay after admission: it retries with the rotated resume
  credential and bounded backoff.
- Simulation restart or deployment: active matches end. The client displays a
  clear match-ended message and returns users to the lobby.
- API deployment: waiting-room connections reconnect. Because the alpha has one
  API instance, presence is reconstructed from reconnecting clients.

Production deployment documentation must warn operators not to deploy the
simulation during active playtests. Durable match recovery is a later phase.

## Verification

Repository verification must include:

- existing C++ simulation, backend, and client unit/integration suites;
- tests for production URL validation and environment configuration;
- protocol tests proving tickets are absent from WebSocket URLs;
- authentication tests proving input-before-auth is rejected;
- reconnection tests covering rotation, expiry, and invalid credentials;
- tests proving the development bypass is disabled in production;
- container image builds and non-root runtime checks;
- local container smoke tests for all health endpoints;
- a deployed two-browser room-to-match test on every map;
- a deployed test from two separate networks to prove public connectivity;
- inspection of platform logs to confirm admission credentials are absent.

The public alpha is releasable only when all checks pass and both deployed health
checks are green.

## User-owned account steps

The user performs only actions that require account ownership, billing consent,
or interactive browser authentication:

1. Sign in to the existing Vercel CLI with `vercel login` and choose the Vercel
   account or team that should own the game.
2. Create or select a Fly.io account, install `flyctl` with Homebrew if needed,
   and run `fly auth login`.
3. Choose the Fly.io organization and approve any required billing setup.
4. Provision one Upstash Redis database through the Vercel Marketplace or
   Upstash console and retain its TLS endpoint/password for secret configuration.
5. Approve the final generated Vercel and Fly.io application names and region.

No secret is committed to Git. The implementation instructions will set secrets
through Vercel and Fly.io secret stores.

## Delivery sequence

1. Implement and test production configuration boundaries.
2. Replace URL-based WebSocket tickets and add bounded reconnection.
3. Add production abuse controls and disable development bypasses.
4. Add API and simulation Dockerfiles plus Fly.io manifests.
5. Add Vercel SPA/build configuration.
6. Run all local tests and container smoke tests.
7. Perform the user-owned login and resource-creation steps.
8. Deploy the simulation, lobby, and frontend in that order.
9. Set final cross-service URLs and origins, then redeploy immutable builds.
10. Run deployed multiplayer, map, security-log, and failure-path verification.
