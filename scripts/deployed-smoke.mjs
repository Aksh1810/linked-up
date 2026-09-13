import { fileURLToPath } from "node:url";

const requiredSecurityHeaders = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
];

function endpoint(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

async function expectResponse(response, status, label) {
  if (response.status !== status) {
    let detail = "";
    try {
      const problem = await response.clone().json();
      if (typeof problem?.title === "string") detail = ` (${problem.title})`;
    } catch { /* Non-JSON failures are described by status only. */ }
    throw new Error(`${label} returned HTTP ${response.status}; expected ${status}${detail}.`);
  }
  return response;
}

async function json(response, label) {
  try { return await response.json(); }
  catch { throw new Error(`${label} did not return JSON.`); }
}

function headers(token, hasBody = false) {
  return {
    ...(token ? { "X-Player-Token": token } : {}),
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

function session(value, label) {
  if (!value || typeof value !== "object" || !value.room || !value.session
    || typeof value.room.code !== "string" || typeof value.session.playerId !== "string"
    || typeof value.session.token !== "string" || value.session.token.length < 1) {
    throw new Error(`${label} returned an invalid public room session.`);
  }
  if (JSON.stringify(value.room).includes(value.session.token)) {
    throw new Error(`${label} exposed a player token in public room state.`);
  }
  return value;
}

export async function verifyDeployment(baseUrl, fetchImpl = fetch) {
  let checks = 0;
  const get = (path, init) => fetchImpl(endpoint(baseUrl, path), { signal: AbortSignal.timeout(20_000), ...init });

  const landing = await expectResponse(await get("/"), 200, "Landing page");
  if (!landing.headers.get("content-type")?.includes("text/html")) throw new Error("Landing page is not HTML.");
  checks++;
  for (const name of requiredSecurityHeaders) {
    if (!landing.headers.get(name)) throw new Error(`Landing page is missing ${name}.`);
  }
  const csp = landing.headers.get("content-security-policy");
  if (!csp?.includes("wasm-unsafe-eval") || !csp.includes("worker-src")) {
    throw new Error("Landing page CSP does not permit the Wasm worker.");
  }
  checks++;

  const deepRoute = await expectResponse(await get("/room/ABCD"), 200, "Room deep link");
  if (!deepRoute.headers.get("content-type")?.includes("text/html")) throw new Error("Room deep link is not the SPA.");
  checks++;

  const created = session(await json(await expectResponse(await get("/api/rooms", {
    method: "POST", headers: headers(undefined, true), body: JSON.stringify({ capacity: 2 }),
  }), 201, "Create room"), "Create room"), "Create room");
  const code = created.room.code;
  const host = created.session;
  checks++;

  const publicRoom = await json(await expectResponse(await get(`/api/rooms/${code}`), 200, "Read room"), "Read room");
  if (JSON.stringify(publicRoom).includes(host.token)) throw new Error("Room lookup exposed the host token.");
  checks++;

  const mapped = await json(await expectResponse(await get(`/api/rooms/${code}/map`, {
    method: "POST", headers: headers(host.token, true), body: JSON.stringify({ mapId: "relay-ridge" }),
  }), 200, "Select map"), "Select map");
  if (mapped.mapId !== "relay-ridge") throw new Error("Host map selection was not persisted.");
  checks++;

  const joined = session(await json(await expectResponse(await get(`/api/rooms/${code}/join`, {
    method: "POST",
  }), 201, "Join room"), "Join room"), "Join room");
  const guest = joined.session;
  checks++;

  await expectResponse(await get(`/api/rooms/${code}/signals`, {
    method: "POST", headers: headers(undefined, true), body: JSON.stringify({}),
  }), 401, "Unauthenticated signal");
  checks++;

  const signal = { type: "ready", senderId: guest.playerId, recipientId: host.playerId };
  await expectResponse(await get(`/api/rooms/${code}/signals`, {
    method: "POST", headers: headers(guest.token, true), body: JSON.stringify(signal),
  }), 201, "Authorized signal");
  checks++;

  const mailbox = await json(await expectResponse(await get(`/api/rooms/${code}/signals?after=0`, {
    headers: headers(host.token),
  }), 200, "Signal mailbox"), "Signal mailbox");
  if (!mailbox || !Array.isArray(mailbox.signals)) throw new Error("Signal mailbox returned an invalid payload.");
  checks++;

  await expectResponse(await get(`/api/rooms/${code}/start`, {
    method: "POST", headers: headers(guest.token),
  }), 403, "Guest start attempt");
  checks++;

  const started = await json(await expectResponse(await get(`/api/rooms/${code}/start`, {
    method: "POST", headers: headers(host.token),
  }), 200, "Host start"), "Host start");
  if (started.status !== "starting" || typeof started.matchId !== "string") {
    throw new Error("Host start did not create a match.");
  }
  checks++;

  return { roomCode: code, checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("Usage: node scripts/deployed-smoke.mjs <base-url>");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyDeployment(baseUrl);
      console.log(`Deployment smoke passed (${result.checks} checks, room ${result.roomCode}).`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Deployment smoke failed.");
      process.exitCode = 1;
    }
  }
}
