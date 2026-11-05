'use client';

import { sanitizeUserError } from '@/components/states/ErrorNote';

/**
 * Root-error boundary. It replaces app/layout.tsx, so it must not depend on
 * the app root layout, providers, fonts, context — or even globals.css, which
 * may itself be what failed to load. Everything (focus ring, reduced-motion
 * handling, layout) is inline or in this screen's own <style> tag.
 * Only the sanitized message is shown — never error.stack or digest internals.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <title>Strike — something went wrong</title>
        <style>{`
          @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          }
          a:focus-visible, button:focus-visible {
            outline: 3px solid #2151F5;
            outline-offset: 2px;
          }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F6F7F9',
          color: '#0A0C10',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <main style={{ textAlign: 'center', padding: 48, maxWidth: 480 }}>
          <div role="alert">
            <div style={{ fontSize: 34, marginBottom: 12 }} aria-hidden="true">
              ⚠️
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: '#4A505C', margin: '0 0 4px' }}>
              The app failed to start, so none of its pages could render.
              This usually clears up on a retry — your funds and open rounds live
              on-chain and are unaffected.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: '#4A505C', margin: '0 0 20px' }}>
              {sanitizeUserError(error)}
            </p>
          </div>
          <button
            type="button"
            autoFocus
            onClick={reset}
            style={{
              border: 0,
              cursor: 'pointer',
              borderRadius: 999,
              padding: '10px 22px',
              fontSize: 14,
              fontWeight: 600,
              color: '#fff',
              background: '#2151F5',
            }}
          >
            Try again
          </button>
          <a
            href="/"
            style={{
              display: 'inline-block',
              marginLeft: 12,
              fontSize: 14,
              fontWeight: 500,
              color: '#2B47B2',
              textDecoration: 'underline',
            }}
          >
            Reload the home page
          </a>
        </main>
      </body>
    </html>
  );
}
