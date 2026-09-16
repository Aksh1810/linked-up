import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { verifyDeployment } from "./deployed-smoke.mjs";

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'",
  "permissions-policy": "camera=(), microphone=()",
  "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
};

function listen(headers) {
  const server = createServer((request, response) => {
    Object.entries(headers).forEach(([name, value]) => response.setHeader(name, value));
    if (request.url === "/appsettings.json") { response.setHeader("content-type", "application/json"); return response.end(JSON.stringify({ ApiBaseUrl: "https://backend.example/" })); }
    if (request.url === "/assets/game.js") { response.setHeader("content-type", "text/javascript"); return response.end("export function start() {}"); }
    response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Linked-Up</title>");
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("deployment smoke rejects a missing security header", async () => {
  const incomplete = { ...securityHeaders }; delete incomplete["permissions-policy"];
  const { server, url } = await listen(incomplete);
  try { await assert.rejects(() => verifyDeployment(url), /permissions-policy/i); } finally { server.close(); }
});

test("deployment smoke covers the static client and backend configuration", async () => {
  const { server, url } = await listen(securityHeaders);
  try { assert.deepEqual(await verifyDeployment(url), { checks: 4 }); } finally { server.close(); }
});
