import type { ReactNode } from 'react';

/**
 * N3 THE BRAND MARKS (user-ruled 2026-08-18: FULL-COLOR) — the one mark shelf.
 * Integration-shaped tiles (Connections · door steps · connection-aimed triggers)
 * wear the SERVICE'S OWN mark in its colors (the n8n/Make aliveness); everything
 * core stays monochrome Lucide. ONE registry keyed by the def's service slug —
 * a surface with a private copy is the bug. Marks are vendored bytes forever
 * (the cage: no runtime fetches); each is an honest simplified geometry of the
 * real mark, nominative use (identifying the service), never decoration.
 * A service without a mark answers null — the caller's mono glyph stands (the
 * honest off state, never a broken image). THE REMAINING CATALOG is a recorded
 * fleet wave (one mark file per agent, this registry the landing).
 */

const M: Record<string, (s: number) => ReactNode> = {
  slack: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <g fill="none">
        <rect x="9.7" y="2.2" width="3.6" height="8.4" rx="1.8" fill="#36C5F0" />
        <rect x="13.9" y="9.7" width="8.4" height="3.6" rx="1.8" fill="#2EB67D" />
        <rect x="10.7" y="13.9" width="3.6" height="8.4" rx="1.8" fill="#ECB22E" />
        <rect x="1.7" y="10.7" width="8.4" height="3.6" rx="1.8" fill="#E01E5A" />
      </g>
    </svg>
  ),
  'google-sheets': (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" fill="#188038" />
      <path d="M14 2v5h5z" fill="#8CE09B" />
      <rect x="8" y="11" width="8" height="6.4" rx="0.8" fill="#fff" />
      <path d="M8 13.1h8M8 15.2h8M12 11v6.4" stroke="#188038" strokeWidth="1" />
    </svg>
  ),
  gmail: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="4.5" width="20" height="15" rx="2" fill="#fff" />
      <path d="M4 19.5V8l8 6 8-6v11.5" fill="none" stroke="#EA4335" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  'google-drive': (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <path d="M8.6 3h6.8l6.2 10.8h-6.8z" fill="#FFBA00" />
      <path d="M8.6 3 2.4 13.8l3.4 5.9L12 9z" fill="#00AC47" />
      <path d="M5.8 19.7h12.4l3.2-5.9H9.2z" fill="#2684FC" />
    </svg>
  ),
  'google-calendar': (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2.5" fill="#4285F4" />
      <rect x="6.4" y="7.2" width="11.2" height="10.4" rx="1" fill="#fff" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.5" fontWeight="600" fill="#4285F4" fontFamily="var(--sans)">31</text>
    </svg>
  ),
  notion: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <rect x="3.5" y="3" width="17" height="18" rx="2" fill="#fff" />
      <path d="M8.4 17V7.6l7.2 9.4V7.6" fill="none" stroke="#111" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  stripe: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="4.2" fill="#635BFF" />
      <path d="M15.3 8.6c-1-.5-2.4-.8-3.5-.6-1 .1-1.9.7-1.8 1.7.1 1.7 5.5 1.2 5.4 4.3-.1 2-2 2.8-3.9 2.8-1.3 0-2.6-.3-3.6-.9" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  airtable: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3.4 2.8 7l9.2 3.6L21.2 7z" fill="#FCB400" />
      <path d="M2.8 8.8v7.6l8 3.2v-7.7z" fill="#F82B60" />
      <path d="M13.2 11.9v7.7l8-3.2V8.8z" fill="#18BFFF" />
    </svg>
  ),
  telegram: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="#26A5E4" />
      <path d="m6.4 11.7 10.2-4-1.7 9.1c-.1.6-.5.7-1 .4l-2.6-1.9-1.3 1.2c-.2.2-.4.3-.7.3l.3-2.7 5-4.5c.2-.2 0-.3-.3-.1l-6.2 3.9-2.6-.8c-.6-.2-.6-.6.1-.9z" fill="#fff" />
    </svg>
  ),
  discord: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <path d="M6.8 5.6A16 16 0 0 1 12 4.8c1.9 0 3.6.3 5.2.8 1.9 2.7 2.8 5.8 2.5 9.2a13 13 0 0 1-4 2.1l-.9-1.5c.5-.2 1-.5 1.4-.8-2.6 1.2-5.8 1.2-8.4 0 .4.3.9.6 1.4.8l-.9 1.5a13 13 0 0 1-4-2.1c-.3-3.4.6-6.5 2.5-9.2z" fill="#5865F2" />
      <ellipse cx="9.4" cy="11.8" rx="1.4" ry="1.6" fill="#fff" />
      <ellipse cx="14.6" cy="11.8" rx="1.4" ry="1.6" fill="#fff" />
    </svg>
  ),
  twilio: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="#F22F46" strokeWidth="2.4" />
      <circle cx="9.4" cy="9.4" r="1.7" fill="#F22F46" />
      <circle cx="14.6" cy="9.4" r="1.7" fill="#F22F46" />
      <circle cx="9.4" cy="14.6" r="1.7" fill="#F22F46" />
      <circle cx="14.6" cy="14.6" r="1.7" fill="#F22F46" />
    </svg>
  ),
  linear: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="#5E6AD2" />
      <path d="M6.5 13.5 10.5 17.5M6.7 9.4l7.9 7.9M9.4 6.7l7.9 7.9M13.5 6.5l4 4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  resend: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="4.2" fill="#0f0f0f" stroke="rgba(255,255,255,.14)" strokeWidth="1" />
      <path d="M8.6 17V7h4.2a3 3 0 0 1 0 6H8.6m4.6 0 3.4 4" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/** The one door: the service's full-color mark, or null — the caller's mono
 * glyph stands (absence is the off state; a broken image never renders). */
export function brandMarkFor(service: string | undefined, size = 28): ReactNode | null {
  if (service === undefined) return null;
  return M[service]?.(size) ?? null;
}
