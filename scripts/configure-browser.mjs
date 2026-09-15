import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const raw = process.env.LINKEDUP_API_URL;
if (!raw) throw new Error('Set LINKEDUP_API_URL to the public HTTPS .NET backend URL.');
const api = new URL(raw);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
if ((api.protocol !== 'https:' && !(local && api.protocol === 'http:')) || api.username || api.password || api.search || api.hash || api.pathname !== '/') {
  throw new Error('LINKEDUP_API_URL must be an HTTPS origin (HTTP is allowed only for local development).');
}
const socket = api.origin.replace(/^http/, 'ws');
const appsettings = process.argv[2] ?? 'artifacts/browser/wwwroot/appsettings.json';
await mkdir(dirname(appsettings), { recursive: true });
await writeFile(appsettings, JSON.stringify({ ApiBaseUrl: api.origin + '/' }));
// Build Output API keeps the deployment static; legacy api/ files are never deployed.
await mkdir('.vercel/output', { recursive: true });
const csp = `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${api.origin} ${socket}; worker-src 'self' blob:; manifest-src 'self'`;
await writeFile('.vercel/output/config.json', JSON.stringify({ version: 3, routes: [
  { src: '/(.*)', headers: { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' }, continue: true },
  { src: '/(?:index\\.html|appsettings\\.json|_framework/(?:blazor\\.(?:boot\\.json|webassembly\\.js)|dotnet\\.js))', headers: { 'Cache-Control': 'no-cache' }, continue: true },
  { handle: 'filesystem' },
  { src: '/(?:_framework|assets)/(.*)', status: 404 },
  { src: '/.*', dest: '/index.html' }
] }, null, 2));
