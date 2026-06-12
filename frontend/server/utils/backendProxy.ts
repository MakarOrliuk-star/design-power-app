import http from "node:http";
import https from "node:https";
import {
  type H3Event,
  getRequestHeaders,
  readRawBody,
  setResponseStatus,
  setResponseHeader,
  appendResponseHeader,
  sendStream,
} from "h3";

// Hop-by-hop headers must not be forwarded verbatim (RFC 7230 §6.1) + host (the
// upstream client sets its own).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/**
 * Manual reverse proxy to the backend that PRESERVES 3xx redirects and Set-Cookie
 * headers — unlike Nitro's routeRules proxy (fetch-based), which follows redirects
 * server-side and swallows the cookie, breaking the OAuth flow.
 *
 * The browser only ever talks to the frontend origin, so the session cookie stays
 * first-party (works on mobile, where cross-site third-party cookies are blocked).
 * Backend URL is read at RUNTIME from NUXT_BACKEND_ORIGIN.
 */
export async function proxyToBackend(event: H3Event): Promise<unknown> {
  const origin = process.env.NUXT_BACKEND_ORIGIN || "http://localhost:3001";
  const target = new URL(event.path, origin); // event.path includes the query string
  console.log("TARGET URL:", target.href); // test ping
  const client = target.protocol === "https:" ? https : http;

  const headers: Record<string, string | string[] | undefined> = { ...getRequestHeaders(event) };
  delete headers.host;

  const method = event.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await readRawBody(event, false);

  const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = client.request(target, { method, headers }, resolve);
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

  console.log("BACKEND STATUS:", upstream.statusCode);
  
  setResponseStatus(event, upstream.statusCode ?? 502);
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value == null || HOP_BY_HOP.has(key)) continue;
    if (key === "set-cookie") {
      for (const cookie of Array.isArray(value) ? value : [value]) {
        appendResponseHeader(event, "set-cookie", cookie);
      }
    } else {
      setResponseHeader(event, key, value);
    }
  }
  return sendStream(event, upstream);
}
