# Architecture

Linked-Up has separate control-plane and gameplay paths.

| Component | Responsibility |
| --- | --- |
| Vercel static output | SPA shell, Babylon.js renderer, Web Worker, and Wasm artifact |
| Vercel Functions | Strict room, presence, host action, and WebRTC signaling endpoints |
| Redis | Expiring public room state, hashed player credentials, rate-limit buckets, and recipient-only signaling mailboxes |
| Host browser | Authoritative fixed-step match and one WebRTC connection per guest |
| Guest browser | Local input/prediction and validated host-snapshot presentation |

## Room control plane

Room create/join responses return a private per-player token. The browser keeps it in that tab's `sessionStorage` and sends it in `X-Player-Token` only for authenticated requests. Redis stores a SHA-256 digest, never the raw token. Public room responses have an exact schema and cannot contain tokens or signaling bodies.

Browsers poll public room state with ETags, refresh presence, and back off after transient failures. Redis transactions enforce capacity, host-only map/start operations, and host migration. Starting a full room assigns a public match ID and protocol version 1; the private session remains available for authenticated signaling and reload retry.

## Peer-hosted match

The host opens three DataChannels per guest: reliable ordered control, unreliable unordered input, and unreliable unordered snapshots. Temporary offers, answers, and ICE candidates pass through recipient-only Redis mailboxes. Once every channel is ready, the host sends the protocol-1 match handshake and countdown control message.

After the countdown, the host creates a dedicated Web Worker. The worker loads the generated C++/Jolt Wasm module, validates all commands, advances a monotonic 60 Hz fixed clock with an eight-step catch-up cap, and emits validated snapshots every third tick. The main thread renders the host snapshot locally and broadcasts the same state to guests. Guest input is validated by the peer codec and applied only by the host simulation. Disconnecting a guest neutralizes that player's latest input.

The Wasm build uses Jolt `v5.6.0`, cross-platform deterministic mode, a one-megabyte stack required by Jolt collision jobs, exception-safe validation boundaries, and a writable project-local Emscripten cache. A parity test drives every map with 2, 3, and 4 players for 240 ticks and compares native and Wasm state within `0.00001` world units.

## Trust and availability boundaries

- Browsers never accept player transforms from another guest.
- Every Wasm snapshot is parsed through the gameplay protocol before rendering or transmission.
- Signaling messages are bounded, exact-schema, sender-authenticated, and recipient-only.
- No token, SDP, or ICE candidate is included in public error copy.
- The host is authoritative and must keep the page open and visible.
- There is no TURN relay in the free alpha; direct ICE can fail on restrictive networks.
- A host departure ends the guest match. Guest departure does not transfer live simulation authority.

The older ASP.NET/C++ server path remains for native local engineering, but it is not part of the Vercel production artifact.
