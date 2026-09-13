import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const securityNames = [
  "content-security-policy", "permissions-policy", "referrer-policy",
  "x-content-type-options", "x-frame-options",
];
const forbidden = ["ws://127.0.0.1:9002", "player=blue", "player=orange"];

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch { return false; }
}

async function filesBelow(root) {
  if (!await exists(root)) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else result.push(path);
  }
  return result;
}

function result(errors) { return { valid: errors.length === 0, errors }; }

export async function verifyProjectFiles(root) {
  const errors = [];
  let config;
  try { config = JSON.parse(await readFile(join(root, "vercel.json"), "utf8")); }
  catch { return result(["vercel.json is missing or invalid."]); }
  if (config.buildCommand !== "npm run build") errors.push("Vercel must run the root build.");
  if (config.outputDirectory !== "client/dist") errors.push("Vercel output must be client/dist.");
  if (typeof config.installCommand !== "string" || !config.installCommand.includes("client")) {
    errors.push("Client dependencies must be installed.");
  }
  if (!config.functions || !Object.keys(config.functions).some((key) => key.startsWith("api/"))) {
    errors.push("API Functions are not configured.");
  }
  const rewrite = Array.isArray(config.rewrites) ? config.rewrites.find((item) => item.destination === "/index.html") : undefined;
  if (!rewrite || typeof rewrite.source !== "string" || !rewrite.source.includes("?!api") || !rewrite.source.includes("assets")) {
    errors.push("The SPA rewrite must exclude API and static assets.");
  }
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const assetCache = headers.find((item) => item.source === "/assets/(.*)");
  if (!assetCache || !JSON.stringify(assetCache).includes("immutable")) errors.push("Assets need immutable caching.");
  const names = new Set(headers.flatMap((entry) => Array.isArray(entry.headers)
    ? entry.headers.map((header) => String(header.key).toLowerCase()) : []));
  for (const name of securityNames) if (!names.has(name)) errors.push(`Missing ${name} header.`);
  const csp = JSON.stringify(headers);
  if (!csp.includes("wasm-unsafe-eval") || !csp.includes("worker-src")) errors.push("CSP must allow the Wasm worker.");

  let environment = "";
  try { environment = await readFile(join(root, ".env.example"), "utf8"); }
  catch { errors.push(".env.example is missing."); }
  const assignments = environment.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  if (assignments.length !== 1 || assignments[0] !== "REDIS_URL=") {
    errors.push(".env.example must name REDIS_URL without a credential value.");
  }
  return result(errors);
}

export async function verifyVercelOutput(root) {
  const errors = [];
  const staticRoot = join(root, "static");
  const staticFiles = await filesBelow(staticRoot);
  if (!await exists(join(staticRoot, "index.html"))) errors.push("Static SPA index is missing.");
  const wasm = staticFiles.filter((path) => extname(path) === ".wasm");
  if (wasm.length === 0) errors.push("Wasm simulation asset is missing.");
  else {
    const magic = await readFile(wasm[0]);
    if (magic.length < 4 || magic.subarray(0, 4).toString("hex") !== "0061736d") {
      errors.push("Wasm asset is invalid.");
    }
  }
  const functionFiles = await filesBelow(join(root, "functions"));
  const functions = functionFiles
    .filter((path) => path.endsWith(".vc-config.json"))
    .map((path) => relative(join(root, "functions"), dirname(path)))
    .sort();
  const expectedFunctions = [join("api", "rooms", "[...path].func"), join("api", "rooms", "index.func")].sort();
  if (JSON.stringify(functions) !== JSON.stringify(expectedFunctions)) {
    errors.push(`Expected only the room API Functions; found ${functions.join(", ") || "none"}.`);
  }
  let configText = "";
  try { configText = (await readFile(join(root, "config.json"), "utf8")).toLowerCase(); }
  catch { errors.push("Vercel output config is missing."); }
  for (const name of securityNames) if (!configText.includes(name)) errors.push(`Built output lacks ${name}.`);
  if (!configText.includes("wasm-unsafe-eval") || !configText.includes("worker-src")) {
    errors.push("Built CSP blocks the Wasm worker.");
  }
  if (!configText.includes("immutable")) errors.push("Built assets are not immutable.");
  for (const path of staticFiles.filter((item) => [".html", ".js", ".css"].includes(extname(item)))) {
    const text = await readFile(path, "utf8");
    for (const value of forbidden) {
      if (text.includes(value)) errors.push(`Production bypass found in ${relative(staticRoot, path)}.`);
    }
  }
  return result(errors);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const checked = target
    ? await verifyVercelOutput(target)
    : await verifyProjectFiles(new URL("..", import.meta.url).pathname);
  if (!checked.valid) {
    for (const error of checked.errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(target ? "Vercel output verification passed." : "Vercel project configuration passed.");
  }
}
