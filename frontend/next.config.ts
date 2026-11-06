import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

loadEnvConfig(`${__dirname}/..`, process.env.NODE_ENV !== "production", console, true);

const backendUrl = process.env.BACKEND_URL?.trim().replace(/\/+$/, "");
const DEV_BACKEND_URL = "http://127.0.0.1:8080";

const config = (phase: string): NextConfig => ({
  transpilePackages: ["tapgrid"],
  experimental: {
    proxyTimeout: 420_000,
    optimizePackageImports: [
      "lucide-react",
      "framer-motion",
      "@tanstack/react-query",
    ],
  },
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
        source: "/((?!api/).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
});

export default config;
