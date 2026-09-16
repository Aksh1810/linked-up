import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyProjectFiles, verifyVercelOutput } from "./verify-vercel-build.mjs";

test("project config builds the static Blazor site with safe headers", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const result = await verifyProjectFiles(root);
  assert.deepEqual(result, { valid: true, errors: [] });

  const env = await readFile(join(root, ".env.example"), "utf8");
  assert.match(env, /^LINKEDUP_API_URL=$/m);
});

test("output verifier checks Blazor assets, headers, backend config, and bypass absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "linked-up-vercel-output-"));
  await mkdir(join(root, "static", "assets"), { recursive: true });
  await mkdir(join(root, "static", "_framework"), { recursive: true });
  await writeFile(join(root, "static", "index.html"), "<main>Linked-Up</main>");
  await writeFile(join(root, "static", "assets", "game.js"), "export function start() {}");
  await writeFile(join(root, "static", "_framework", "blazor.webassembly.js"), "");
  await writeFile(join(root, "static", "appsettings.json"), JSON.stringify({ ApiBaseUrl: "https://backend.example/" }));
  await writeFile(join(root, "config.json"), JSON.stringify({
    version: 3,
    routes: [
      { src: "/_framework/(.*)", headers: { "cache-control": "no-cache" }, continue: true },
      { src: "/assets/(.*)", headers: { "cache-control": "no-cache" }, continue: true },
      { src: "/(.*)", headers: {
        "content-security-policy": "default-src 'self'; worker-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY",
        "referrer-policy": "no-referrer", "permissions-policy": "camera=()",
      }, continue: true },
      { handle: "filesystem" }, { src: "/(.*)", dest: "/index.html" },
    ],
  }));
  assert.deepEqual(await verifyVercelOutput(root), { valid: true, errors: [] });
  const configPath = join(root, "config.json");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, config.replaceAll("no-cache", "public, max-age=31536000, immutable"));
  assert.equal((await verifyVercelOutput(root)).valid, false);
  await writeFile(configPath, config);
  await writeFile(join(root, "static", "appsettings.json"), JSON.stringify({ ApiBaseUrl: "http://127.0.0.1:5100/" }));
  assert.equal((await verifyVercelOutput(root)).valid, false);
  await writeFile(join(root, "static", "appsettings.json"), JSON.stringify({ ApiBaseUrl: "https://backend.example/" }));
  await writeFile(join(root, "static", "index.html"), "ws://127.0.0.1:9002");
  assert.equal((await verifyVercelOutput(root)).valid, false);
});
