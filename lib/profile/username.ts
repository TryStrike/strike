/**
 * Username rules for `user_profiles.username`.
 *
 * What the server actually accepts (verified against the write path this app
 * uses, `POST /api/db` -> backend/crates/core/src/gateway.rs):
 *   - `username` is a writable column of `user_profiles` (alongside
 *     `user_address`, `updated_at`), so any JSON string survives normalisation;
 *   - the column is `TEXT UNIQUE`, so a duplicate is rejected with a unique
 *     violation and a non-string is rejected before SQL;
 *   - there is NO length or charset constraint in SQL
 *     (backend/schema.sql).
 *
 * The server is therefore a uniqueness check, not a content check, and the
 * username is echoed to other players (/leaderboard, /api/bets/leaderboard).
 * These rules are the content gate: they are what the app promises to accept,
 * they reject control characters and HTML, and they cap the length so the
 * stored value is always of the form `<handle>.strike`.
 *
 * Pure module: no I/O, no React, unit-testable on its own.
 */

export const USERNAME_SUFFIX = '.strike';
export const MIN_HANDLE_LENGTH = 2;
export const MAX_HANDLE_LENGTH = 24;

export type UsernameErrorCode =
    | 'empty'
    | 'too_short'
    | 'too_long'
    | 'control_char'
    | 'html_char'
    | 'internal_space'
    | 'illegal_char'
    | 'edge_char'
    | 'repeated_dot'
    | 'reserved'
    | 'not_a_string';

export type UsernameValidation =
    | { ok: true; handle: string; stored: string; display: string; error: null }
    | { ok: false; handle: ''; stored: ''; display: ''; error: UsernameError };

export interface UsernameError {
    code: UsernameErrorCode;
    message: string;
}

/**
 * Names that would read as an official channel on the leaderboard. Compared
 * case-insensitively against the handle without its suffix.
 */
const RESERVED_HANDLES = new Set([
    'admin',
    'administrator',
    'strike',
    'strike-admin',
    'support',
    'help',
    'team',
    'official',
    'system',
    'moderator',
    'mod',
    'root',
    'null',
]);

/** C0/C1 controls + DEL: invisible, and the classic log/smuggling vector. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
/** Anything that could begin or end a markup construct if rendered raw. */
const HTML_CHARS = /[<>&"'`=/\\]/;
/** Handle charset: letters (any script), digits, and the three separators. */
const LEGAL_HANDLE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** Remove a trailing `.strike` the user may have typed themselves. */
function stripSuffix(value: string): string {
    const lower = value.toLowerCase();
    return lower.endsWith(USERNAME_SUFFIX)
        ? value.slice(0, value.length - USERNAME_SUFFIX.length)
        : value;
}

function fail(code: UsernameErrorCode, message: string): UsernameValidation {
    return { ok: false, handle: '', stored: '', display: '', error: { code, message } };
}

/**
 * Trim + lowercase + collapse the junk around a handle. Deliberately does NOT
 * repair the middle of the string: an illegal character is reported, never
 * silently deleted, so what the player typed is what gets rejected.
 */
export function normalizeHandle(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return stripSuffix(raw.trim()).replace(/^@+/, '').trim().toLowerCase();
}

/**
 * Full rule check. Returns the canonical pieces on success:
 * `handle` (display without suffix), `stored` (what goes into user_profiles),
 * `display` (what the UI shows).
 */
export function validateUsername(raw: unknown): UsernameValidation {
    if (typeof raw !== 'string') return fail('not_a_string', 'Username must be text.');

    const trimmed = raw.trim();
    if (!trimmed) return fail('empty', 'Enter a username.');

    // Scan the RAW value: a control character the user pasted must be reported
    // even though .trim() would have removed some of them.
    if (CONTROL_CHARS.test(raw)) {
        return fail('control_char', 'Username contains invisible control characters.');
    }
    if (HTML_CHARS.test(trimmed)) {
        return fail('html_char', 'Username cannot contain <, >, &, quotes, slashes or =.');
    }

    const handle = normalizeHandle(trimmed);
    if (!handle) return fail('empty', 'Enter a username.');

    if (/\s/.test(handle)) {
        return fail('internal_space', 'Username cannot contain spaces — use . or - instead.');
    }
    if (handle.length < MIN_HANDLE_LENGTH) {
        return fail('too_short', `Username is too short (min ${MIN_HANDLE_LENGTH} characters).`);
    }
    if (handle.length > MAX_HANDLE_LENGTH) {
        return fail('too_long', `Username is too long (max ${MAX_HANDLE_LENGTH} characters).`);
    }
    if (!LEGAL_HANDLE.test(handle)) return fail('illegal_char', 'Username uses unsupported characters.');
    if (/[._-]$/.test(handle)) return fail('edge_char', 'Username cannot end with . _ or -.');
    if (handle.includes('..')) return fail('repeated_dot', 'Username cannot contain consecutive dots.');
    if (RESERVED_HANDLES.has(handle)) return fail('reserved', 'That username is reserved.');

    const stored = `${handle}${USERNAME_SUFFIX}`;
    return { ok: true, handle, stored, display: handle, error: null };
}

/**
 * Display form of a stored username: suffix gone, nothing else transformed.
 * Unknown/legacy spellings (no suffix, mixed case) come back as-is so a row
 * written by an older release still reads correctly — and still only ever as
 * text, never as markup.
 */
export function displayUsername(stored: string | null | undefined): string | null {
    if (typeof stored !== 'string') return null;
    const trimmed = stored.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    return lower.endsWith(USERNAME_SUFFIX) ? trimmed.slice(0, trimmed.length - USERNAME_SUFFIX.length) : trimmed;
}

/** True when the value already satisfies the rules (used to seed the editor). */
export function isStoredUsername(value: string | null | undefined): boolean {
    const result = validateUsername(value ?? '');
    return result.ok && (value ?? '').toLowerCase().endsWith(USERNAME_SUFFIX);
}

/**
 * Whether a save should be attempted: mirrors the server's own acceptance
 * (a string, unique-checked) plus the client rules above.
 */
export function canSubmitUsername(raw: unknown): boolean {
    return validateUsername(raw).ok;
}

/**
 * Turn a failed save into a message. The gateway only ever tells us "unique
 * violation" or "request failed", so the UI distinguishes those two instead of
 * claiming a taken name when the network dropped.
 */
export function usernameSaveErrorMessage(cause: 'taken' | 'invalid' | 'network' | 'unknown'): string {
    switch (cause) {
        case 'taken':
            return 'That username is already claimed by another wallet.';
        case 'invalid':
            return 'The server rejected that username. Try a different one.';
        case 'network':
            return 'Could not reach the profile service. Your name is unchanged.';
        case 'unknown':
        default:
            return 'Username could not be saved. Please try again.';
    }
}
