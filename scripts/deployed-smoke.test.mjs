import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { verifyDeployment } from "./deployed-smoke.mjs";

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'",
  "permissions-policy": "camera=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function listen(headers) {
  const players = [{ id: "host-id", color: "blue", isHost: true }];
  let mapId = "classic-ascent";
  let status = "waiting";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    Object.entries(headers).forEach(([name, value]) => response.setHeader(name, value));
    response.setHeader("content-type", url.pathname.startsWith("/api/") ? "application/json" : "text/html");

    const send = (code, body = "") => { response.statusCode = code; response.end(body); };
    const room = () => ({
      code: "ABCD", capacity: 2, mapId, status,
      players, version: 1, ...(status === "starting" ? { matchId: "match-id" } : {}),
    });
    const token = request.headers["x-player-token"];

    if (!url.pathname.startsWith("/api/")) return send(200, "<!doctype html><title>Linked-Up</title>");
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return send(201, JSON.stringify({ room: room(), session: { playerId: "host-id", token: "host-secret" } }));
    }
    if (url.pathname === "/api/rooms/ABCD" && request.method === "GET") return send(200, JSON.stringify(room()));
    if (url.pathname === "/api/rooms/ABCD/map" && request.method === "POST") {
      mapId = "relay-ridge";
      return send(200, JSON.stringify(room()));
    }
    if (url.pathname === "/api/rooms/ABCD/join" && request.method === "POST") {
      players.push({ id: "guest-id", color: "orange", isHost: false });
      return send(201, JSON.stringify({ room: room(), session: { playerId: "guest-id", token: "guest-secret" } }));
    }
    if (url.pathname === "/api/rooms/ABCD/start" && request.method === "POST") {
      if (token !== "host-secret") return send(403, JSON.stringify({ title: "Host required" }));
      status = "starting";
      return send(200, JSON.stringify(room()));
    }
    if (url.pathname === "/api/rooms/ABCD/signals" && request.method === "POST") {
      if (!token) return send(401, JSON.stringify({ title: "Invalid room session" }));
      return send(201, JSON.stringify({ cursor: 1 }));
    }
    if (url.pathname === "/api/rooms/ABCD/signals" && request.method === "GET") {
      return send(200, JSON.stringify({ cursor: 1, signals: [] }));
    }
    return send(404, JSON.stringify({ title: "Not found" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  }));
}

test("deployment smoke rejects a missing security header", async () => {
  const incomplete = { ...securityHeaders };
  delete incomplete["permissions-policy"];
  const { server, url } = await listen(incomplete);
  try {
    await assert.rejects(() => verifyDeployment(url), /permissions-policy/i);
  } finally {
    server.close();
  }
});

test("deployment smoke covers the public room and signaling lifecycle", async () => {
  const { server, url } = await listen(securityHeaders);
  try {
    const result = await verifyDeployment(url);
    assert.deepEqual(result, { roomCode: "ABCD", checks: 12 });
  } finally {
    server.close();
  }
});
