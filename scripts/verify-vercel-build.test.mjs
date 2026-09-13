import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyProjectFiles, verifyVercelOutput } from "./verify-vercel-build.mjs";

test("project config builds the SPA and preserves functions with safe headers", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const result = await verifyProjectFiles(root);
  assert.deepEqual(result, { valid: true, errors: [] });

  const tsconfig = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
  assert.equal(tsconfig.compilerOptions.target, "ES2022");

  const ignored = await readFile(join(root, ".vercelignore"), "utf8");
  assert.match(ignored, /\*\*\/\*\.test\.ts/);
});

test("output verifier checks SPA routes, functions, Wasm, headers, and bypass absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "linked-up-vercel-output-"));
  await mkdir(join(root, "static", "assets"), { recursive: true });
  await mkdir(join(root, "functions", "api", "rooms", "index.func"), { recursive: true });
  await mkdir(join(root, "functions", "api", "rooms", "[...path].func"), { recursive: true });
  await writeFile(join(root, "static", "index.html"), "<main>Linked-Up</main>");
  await writeFile(join(root, "static", "assets", "simulation.wasm"), new Uint8Array([0, 97, 115, 109]));
  await writeFile(join(root, "functions", "api", "rooms", "index.func", ".vc-config.json"), "{}");
  await writeFile(join(root, "functions", "api", "rooms", "[...path].func", ".vc-config.json"), "{}");
  await writeFile(join(root, "config.json"), JSON.stringify({
    version: 3,
    routes: [
      { src: "/assets/(.*)", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
      { src: "/api/(.*)", dest: "/api/$1" },
      { src: "/(.*)", headers: {
        "content-security-policy": "default-src 'self'; worker-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY",
        "referrer-policy": "no-referrer", "permissions-policy": "camera=()",
      }, continue: true },
      { handle: "filesystem" }, { src: "/(.*)", dest: "/index.html" },
    ],
  }));
  assert.deepEqual(await verifyVercelOutput(root), { valid: true, errors: [] });
  await writeFile(join(root, "static", "index.html"), "ws://127.0.0.1:9002");
  assert.equal((await verifyVercelOutput(root)).valid, false);
});
