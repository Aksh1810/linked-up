# Architecture

The active deployment uses a C# Blazor WebAssembly client, Babylon.js only as a rendering bridge, and an ASP.NET Core backend running managed BepuPhysics.

| Component | Responsibility |
| --- | --- |
| Vercel static output | Blazor WebAssembly shell and Babylon.js renderer |
| ASP.NET Core on Render | Room REST API, SignalR lobby presence, authenticated gameplay WebSockets, and the 60 Hz match loop |
| Redis | Expiring rooms, hashed player credentials, and persisted lobby state |
| Browser | C# input, authenticated gameplay transport, prediction, interpolation, and UI; Babylon rendering |

## Room control plane

Create and join responses return a private per-player token. The browser sends it in the `X-Player-Token` header for mutations and the SignalR `Subscribe` call; Redis stores a SHA-256 digest. Public room responses never contain tokens. SignalR subscriptions register in-process presence and deliver room updates. A public room refresh every 1.5 seconds provides a fallback. Version and room-identity checks prevent delayed responses from replacing newer state.

The client uses one guarded launch path when the room enters `inGame`, obtaining a ticket from the authenticated launch endpoint. It does not race the server's legacy `MatchReady` notification against that request.

Starting a full room assigns a match ID and protocol version 2. The backend refuses to start until every roster member has an active SignalR subscription.

## Authoritative match

`ManagedMatches` creates one managed `PrototypeSimulation` per room. It advances matches at 60 Hz, broadcasts immutable snapshots every third tick, and enforces ticket expiry, roster identity, monotonic input sequence, input rate limits, disconnect neutralization, match expiry, and bounded WebSocket messages. `GameplayClient` validates the same protocol in the Blazor client and interpolates snapshots before Babylon renders them.

The simulation owns transforms, tether forces, obstacles, checkpoints, resets, and summit completion. The browser owns controls, presentation, and camera movement; it never authors an authoritative transform.

## Trust and availability boundaries

- Browsers never accept unvalidated player transforms.
- Every gameplay message is parsed through the shared C# wire contract.
- No token or credential is included in error copy.
- A disconnected player contributes neutral input; an empty match expires.
- The service is intentionally single-instance on the free Render plan. Redis-backed rooms survive backend restarts, while live matches are recreated by starting a new room.

The retired native prototype remains only as a temporary comparison fixture during migration. It is not referenced by the .NET build or deployment artifact.
