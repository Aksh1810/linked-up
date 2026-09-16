import { fileURLToPath } from "node:url";

const requiredSecurityHeaders = [
  "content-security-policy", "permissions-policy", "referrer-policy",
  "x-content-type-options", "x-frame-options",
];

function endpoint(baseUrl, path) { return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString(); }

async function expect(response, status, label) {
  if (response.status !== status) throw new Error(`${label} returned HTTP ${response.status}; expected ${status}.`);
  return response;
}

export async function verifyDeployment(baseUrl, fetchImpl = fetch, backendUrl) {
  let checks = 0;
  const get = (path, init) => fetchImpl(endpoint(baseUrl, path), { signal: AbortSignal.timeout(20_000), ...init });
  const landing = await expect(await get("/"), 200, "Landing page");
  if (!landing.headers.get("content-type")?.includes("text/html")) throw new Error("Landing page is not HTML.");
  for (const name of requiredSecurityHeaders) if (!landing.headers.get(name)) throw new Error(`Landing page is missing ${name}.`);
  checks++;
  const deepRoute = await expect(await get("/?room=ABCD"), 200, "Room invite link");
  if (!deepRoute.headers.get("content-type")?.includes("text/html")) throw new Error("Room deep link is not the SPA.");
  checks++;
  const settings = await (await expect(await get("/appsettings.json"), 200, "Client settings")).json();
  if (!/^https:\/\/[^/]+\/$/.test(settings.ApiBaseUrl ?? "")) throw new Error("Client settings do not contain a public HTTPS backend origin.");
  checks++;
  await expect(await get("/assets/game.js"), 200, "Babylon renderer");
  checks++;
  if (backendUrl) {
    await expect(await fetchImpl(endpoint(backendUrl, "/health/ready"), { signal: AbortSignal.timeout(20_000) }), 200, "Backend readiness");
    checks++;
  }
  return { checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv[2];
  if (!baseUrl) { console.error("Usage: node scripts/deployed-smoke.mjs <vercel-url> [backend-url]"); process.exitCode = 1; }
  else verifyDeployment(baseUrl, fetch, process.argv[3]).then(result => console.log(`Static deployment checks passed (${result.checks} checks); multiplayer requires the browser smoke test.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
