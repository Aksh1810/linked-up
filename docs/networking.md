# Networking

## Production endpoints

The ASP.NET Core service exposes:

```text
POST /api/rooms
GET  /api/rooms/{code}
POST /api/rooms/{code}/join
POST /api/rooms/{code}/leave
POST /api/rooms/{code}/map
POST /api/rooms/{code}/start
POST /api/rooms/{code}/launch
WS   /hubs/lobby
WS   /gameplay
```

Room mutations authenticate with `X-Player-Token`. Responses are `no-store` JSON. HTTP request bodies are capped at 4 KiB, incoming gameplay messages at the server are capped at 2 KiB, and the client bounds received snapshots at 256 KiB. Abusive IP scopes receive `429`.

Rooms expire in Redis. SignalR delivers room updates immediately; a refresh fallback runs every 1.5 seconds while in the lobby. Closing the lobby connection removes waiting-player presence and clears that client's room view.

## Gameplay

Each player opens one authenticated WebSocket to `/gameplay` using the short-lived ticket returned by `/api/rooms/{code}/launch`. The server sends a `welcome`, countdown messages, and authoritative snapshots at 20 Hz. The client sends bounded `input` messages at 60 Hz.

All frames are UTF-8 JSON with strict size and schema validation. Input sequences must increase. Snapshot player order must exactly match the room roster. A client cannot send a snapshot, select a different identity, or authoritatively change position.

## Connection lifecycle

1. Every player observes the same room and protocol-2 match ID.
2. SignalR subscriptions register every player with `RoomPresence`.
3. The host starts only after all roster members are connected.
4. Each browser redeems its own gameplay ticket on a WebSocket.
5. The server sends `3`, `2`, `1`, `CLIMB!`, then 20 Hz snapshots.
6. Each browser sends only its own input; the server runs the managed simulation.
7. A disconnected player contributes neutral input; an empty match expires.

## Local development

Run Redis, the ASP.NET Core service, and the Blazor development server. The same SignalR and WebSocket paths are used locally and in production; no loopback C++ or query-parameter bypass is part of the active client.
