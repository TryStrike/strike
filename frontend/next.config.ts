import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// One .env.local at the repo root drives the frontend, the Rust backend and contracts/deploy.mjs.
// forceReload: Next already loaded (and cached) env from frontend/, which has none.
loadEnvConfig(`${__dirname}/..`, process.env.NODE_ENV !== "production", console, true);

/**
 * The Rust service owns every `/api/*` path; there is no other backend. Next bakes
 * `rewrites()` into `.next/routes-manifest.json` during `next build`, and
 * `next start` does not re-read this file, so `BACKEND_URL` has to be set for the
 * build. `next dev` falls back to where `cargo run -p server` listens.
 *
 * The proxy is Next's own http-proxy: request bodies, query strings, cookies,
 * `Set-Cookie` (including multiple values) and streamed response bodies pass
 * through unchanged. Next's `x-forwarded-for` keeps what Caddy wrote, which is
 * what the Rust rate limiter reads. SSE stays open as long as the upstream keeps
 * writing; the Rust feed sends a heartbeat every 15s, below `proxyTimeout`.
 * Caddy must not buffer (`flush_interval -1` in backend/deploy/oracle.sh).
 */
const backendUrl = process.env.BACKEND_URL?.trim().replace(/\/+$/, "");
const DEV_BACKEND_URL = "http://127.0.0.1:8080";

const config = (phase: string): NextConfig => ({
  /* Smaller dev cold compiles: tree-shake heavy barrel-export packages */
  experimental: {
    // An accept can wait out 180s of confirmations on each of its two transfers,
    // and the default 30s would turn that into a 500 with the payout still running.
    proxyTimeout: 420_000,
    optimizePackageImports: [
      "lucide-react",
      "framer-motion",
      "@tanstack/react-query",
    ],
  },
  // Empty turbopack config to silence warning
  turbopack: {},
  async rewrites() {
    if (!backendUrl && phase === PHASE_PRODUCTION_BUILD) {
      throw new Error(
        "BACKEND_URL is required for a production build: it is the Rust API that /api/* is proxied to, for example http://127.0.0.1:8080.",
      );
    }
    return {
      beforeFiles: [
        {
          source: "/api/:path*",
          destination: `${backendUrl ?? DEV_BACKEND_URL}/api/:path*`,
        },
      ],
    };
  },
  async headers() {
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      // Keep script policy compatible with Next/Turbopack runtime and in-app tooling.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss:",
      "frame-src 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        // Pages only: the API sets its own (backend/crates/server/src/http.rs).
        source: "/((?!api/).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // COOP same-origin breaks Coinbase Smart Wallet and other popup-based wallets (opener communication).
        ],
      },
    ];
  },
});

export default config;
