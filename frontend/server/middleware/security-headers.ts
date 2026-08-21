import { defineEventHandler, setResponseHeader } from "h3";

/**
 * Security headers for everything the browser gets from this origin.
 *
 * This is the right layer for them: the browser talks ONLY to the frontend
 * (see server/utils/backendProxy.ts), so the HTML document, the Nuxt bundle and
 * the proxied /api + /auth responses all pass through here. The Express app
 * sets its own headers too, but those only matter if the backend is reached
 * directly.
 *
 * Runs before the proxy handlers, which then set their own (disjoint) headers —
 * nothing below collides with what the backend returns.
 */

/**
 * CSP is deliberately REPORT-ONLY for now.
 *
 * Two directives are known-loose and cannot be tightened without changing how
 * the app is built:
 *  - 'unsafe-inline' in style-src: Nuxt injects inline <style> blocks in client
 *    mode, and Konva writes inline styles onto its canvas containers.
 *  - https: in img-src: generated artwork is served from Cloudinary delivery
 *    URLs, and the account/CDN host is not fixed in code.
 *
 * Enforcing this today would risk a blank page in production for no proven
 * gain, so it ships in report-only mode: violations surface in the browser
 * console (and can be pointed at a collector later — this is where a Sentry
 * Security Headers endpoint would go, per sentry-security-basics Step 6),
 * and only once the report is quiet should this become the enforcing header.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
].join("; ");

export default defineEventHandler((event) => {
  // Clickjacking. frame-ancestors above is the modern form; this covers
  // browsers that still honour the legacy header.
  setResponseHeader(event, "X-Frame-Options", "DENY");
  // Stop MIME sniffing turning an uploaded file into an executable script.
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
  // Don't leak internal paths (which carry brand and campaign ids) to
  // third-party hosts like Cloudinary or Google Fonts.
  setResponseHeader(event, "Referrer-Policy", "strict-origin-when-cross-origin");
  // Nothing here needs camera, microphone or geolocation.
  setResponseHeader(
    event,
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  setResponseHeader(event, "Content-Security-Policy-Report-Only", CSP_REPORT_ONLY);

  // HSTS only where TLS actually terminates. Railway serves the app over HTTPS;
  // sending this on plain-HTTP localhost would pin developers' browsers to a
  // scheme the dev server does not speak.
  if (process.env.NODE_ENV === "production") {
    setResponseHeader(event, "Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
});
