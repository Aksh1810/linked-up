import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const securityNames = ["content-security-policy", "permissions-policy", "referrer-policy", "x-content-type-options", "x-frame-options"];
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
  if (config.outputDirectory !== ".vercel/output/static") errors.push("Vercel output must be .vercel/output/static.");
  if (config.installCommand !== "npm ci") errors.push("Vercel must install the root dependencies.");
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const names = new Set(headers.flatMap(entry => Array.isArray(entry.headers)
    ? entry.headers.map(header => String(header.key).toLowerCase()) : []));
  for (const name of securityNames) if (!names.has(name)) errors.push(`Missing ${name} header.`);
  const assetCache = headers.find(item => item.source === "/assets/(.*)");
  if (!assetCache || !JSON.stringify(assetCache).includes("no-cache")) errors.push("The stable game.js URL must revalidate after deployment.");
  if (!JSON.stringify(headers).includes("/_framework/(.*)")) errors.push("Framework assets need an explicit cache policy.");
  let environment = "";
  try { environment = await readFile(join(root, ".env.example"), "utf8"); }
  catch { errors.push(".env.example is missing."); }
  const assignments = environment.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (assignments.length !== 1 || assignments[0] !== "LINKEDUP_API_URL=") errors.push(".env.example must name LINKEDUP_API_URL without a credential value.");
  return result(errors);
}

export async function verifyVercelOutput(root) {
  const errors = [];
  const staticRoot = join(root, "static");
  const staticFiles = await filesBelow(staticRoot);
  const relativeFiles = staticFiles.map(path => relative(staticRoot, path));
  if (!await exists(join(staticRoot, "index.html"))) errors.push("Static SPA index is missing.");
  if (!relativeFiles.some(path => path === "assets/game.js")) errors.push("Babylon rendering bridge is missing.");
  if (!relativeFiles.some(path => path.startsWith("_framework/") && path.endsWith(".js"))) errors.push("Blazor framework assets are missing.");
  let settings;
  try { settings = JSON.parse(await readFile(join(staticRoot, "appsettings.json"), "utf8")); }
  catch { errors.push("Published appsettings.json is missing or invalid."); }
  if (settings && (!/^https:\/\/[^/]+\/$/.test(settings.ApiBaseUrl ?? ""))) errors.push("Published ApiBaseUrl must be a public HTTPS origin.");
  let configText = "";
  try { configText = (await readFile(join(root, "config.json"), "utf8")).toLowerCase(); }
  catch { errors.push("Vercel output config is missing."); }
  for (const name of securityNames) if (!configText.includes(name)) errors.push(`Built output lacks ${name}.`);
  if (!configText.includes("_framework") || !configText.includes("/assets")) errors.push("Built output lacks framework or asset routes.");
  if (configText) {
    const assetRoute = JSON.parse(configText).routes?.find(route => route.src === "/assets/(.*)");
    if (assetRoute?.headers?.["cache-control"] !== "no-cache") errors.push("The stable game.js URL must revalidate after deployment.");
  }
  for (const path of staticFiles.filter(item => [".html", ".js", ".css", ".json"].includes(extname(item)))) {
    const text = await readFile(path, "utf8");
    for (const value of forbidden) if (text.includes(value)) errors.push(`Production bypass found in ${relative(staticRoot, path)}.`);
  }
  return result(errors);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const checked = target ? await verifyVercelOutput(target) : await verifyProjectFiles(new URL("..", import.meta.url).pathname);
  if (!checked.valid) { for (const error of checked.errors) console.error(error); process.exitCode = 1; }
  else console.log(target ? "Vercel output verification passed." : "Vercel project configuration passed.");
}
