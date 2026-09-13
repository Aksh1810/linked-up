# Networking

## Production endpoints

The single Vercel origin serves the SPA and these stateless Function routes:

```text
POST /api/rooms
GET  /api/rooms/{code}
POST /api/rooms/{code}/join
POST /api/rooms/{code}/leave
POST /api/rooms/{code}/map
POST /api/rooms/{code}/start
POST /api/rooms/{code}/presence
GET  /api/rooms/{code}/signals?after={cursor}&limit={count}
POST /api/rooms/{code}/signals
```

Mutation and signaling requests authenticate with `X-Player-Token`. Responses are `no-store`, exact-schema JSON with browser security headers. Request bodies are capped at 64 KiB, signaling envelopes at 16 KiB, ICE candidates at 4 KiB, and abusive scopes receive a stable `429` plus `Retry-After`.

Rooms and signal mailboxes expire in Redis. Conditional room reads use ETags; normal visible-tab polling is once per second, hidden-tab polling is once per ten seconds, and failures back off to ten seconds.

## Direct gameplay

Each guest negotiates one `RTCPeerConnection` with the room host using `stun:stun.cloudflare.com:3478`. No Vercel Function stays open for gameplay and no snapshot is stored in Redis.

DataChannel traffic is split by purpose:

| Channel | Delivery | Content |
| --- | --- | --- |
| `control` | ordered, reliable | protocol handshake, ready, finished, failure |
| `input` | unordered, no retransmits | sequence, client tick, movement axes, jump |
| `snapshot` | unordered, no retransmits | authoritative 20 Hz world state |

All frames are binary-prefixed UTF-8 JSON with strict size and schema validation. Input sequences must increase. Snapshot player order must exactly match the room roster. A guest cannot send a snapshot, select a different identity, or authoritatively change position.

## Connection lifecycle

1. Every player observes the same starting room and protocol-1 match ID.
2. Each browser polls only its own authenticated signal mailbox.
3. The host offers three channels; guests answer and exchange ICE candidates.
4. The host waits until all guest channels are open, then sends the ordered handshake and ready message.
5. All players show `3`, `2`, `1`, `CLIMB!`.
6. The host starts the Wasm simulation; guests send input and receive snapshots.
7. A guest disconnect produces neutral input. A host disconnect ends the guest match.

The peer mesh allows one ICE restart after a 15-second negotiation timeout. If direct ICE still fails, the UI explains that a VPN/firewall or restrictive network may be blocking it. There is intentionally no TURN credential or paid relay dependency in this alpha.

## Local native mode

The repository retains the loopback C++ gameplay server and ASP.NET development stack. Vite development can use the Blue/Orange query bypass against `ws://127.0.0.1:9002`; the production build statically removes that code and its URLs. Native mode is for local engine work and is not a deployment requirement.
