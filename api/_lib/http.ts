import type { VercelRequest, VercelResponse } from "@vercel/node";

export const MAX_BODY_BYTES = 65_536;
const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export class HttpError extends Error {
  readonly status: number;
  readonly title: string;

  constructor(status: number, title: string, message = title) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.title = title;
  }
}

export function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid request");
  }
}

export function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers, ...securityHeaders },
  });
}

export function emptyResponse(status = 204, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers, ...securityHeaders } });
}

export function problemResponse(status: number, title: string): Response {
  return jsonResponse({ type: "about:blank", title, status }, status);
}

export function toRequest(request: VercelRequest): Request {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol ?? "https";
  const host = request.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined;
  return new Request(`${protocol}://${host}${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: hasBody ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : undefined,
  });
}

export async function sendVercelResponse(response: VercelResponse, result: Response): Promise<void> {
  response.status(result.status);
  result.headers.forEach((value, key) => response.setHeader(key, value));
  const body = await result.text();
  if (body.length === 0) response.end();
  else response.send(body);
}
