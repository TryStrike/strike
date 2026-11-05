'use client';

/**
 * Identity block: derived avatar + username, with the editor inline.
 *
 * Validation lives in lib/profile/username.ts (pure, unit-tested); this
 * component only renders the verdict. A username is ALWAYS rendered as text —
 * React's `{value}` interpolation — never through innerHTML, so a pasted
 * `<img onerror=…>` shows up as the literal string it was stored as.
 *
 * The write goes to the same gateway path the rest of the app uses
 * (store -> profileSlice.updateUsername -> POST /api/db), but with the wallet
 * canonicalised first: `user_profiles.user_address` is the primary key, so a
 * checksummed spelling would insert a second row for the same wallet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleNotch, PencilSimple, WarningCircle, X } from '@phosphor-icons/react';
import ProfileAvatar from './ProfileAvatar';
import { displayUsername, validateUsername, usernameSaveErrorMessage, type UsernameValidation } from '@/lib/profile/username';

export type UsernameSaveOutcome = 'ok' | 'rejected' | 'error';

export interface IdentityPanelProps {
    address?: string | null;
    username: string | null;
    /** True while the server-side save is in flight. */
    isSaving?: boolean;
    /** False until the first profile read for this wallet has settled. */
    loadedOnce?: boolean;
    /** The registry read failed: show "unavailable", never "anonymous". */
    nameUnavailable?: boolean;
    /**
     * Persists the handle. The page validates + canonicalises through
     * lib/profile/identity.ts and writes with the shared profile path
     * (store.updateUsername -> POST /api/db), so the rest of the app sees the
     * new name without a second writer.
     */
    onSave: (stored: string) => Promise<{ outcome: UsernameSaveOutcome; message: string | null }>;
    /** Practice wallets have no on-chain identity: block the registry write. */
    readOnly?: boolean;
    readOnlyReason?: string;
}

export function IdentityPanel({
    address,
    username,
    isSaving = false,
    loadedOnce = true,
    nameUnavailable = false,
    onSave,
    readOnly = false,
    readOnlyReason = 'Practice mode cannot register a public identity.',
}: IdentityPanelProps) {
    const display = displayUsername(username);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [result, setResult] = useState<{ outcome: UsernameSaveOutcome; message: string | null } | null>(null);
    const [inFlight, setInFlight] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const validation: UsernameValidation = useMemo(() => validateUsername(draft), [draft]);

    useEffect(() => {
        if (editing) inputRef.current?.focus();
    }, [editing]);

    const openEditor = useCallback(() => {
        setResult(null);
        setDraft(display ?? '');
        setEditing(true);
    }, [display]);

    const closeEditor = useCallback(() => {
        setEditing(false);
        setResult(null);
    }, []);

    const submit = useCallback(async () => {
        if (!validation.ok) return;
        setInFlight(true);
        setResult(null);
        const next = await onSave(validation.stored);
        setInFlight(false);
        setResult(next);
        if (next.outcome === 'ok') setEditing(false);
    }, [onSave, validation]);

    const busy = inFlight || isSaving;
    const showError = editing && draft.trim() !== '' && !validation.ok ? validation.error : null;

    return (
        <div className="flex items-start gap-4" data-testid="identity-panel">
            <ProfileAvatar address={address ?? null} username={username} size={64} className="shrink-0" />

            <div className="min-w-0 flex-1">
                {editing ? (
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                ref={inputRef}
                                type="text"
                                value={draft}
                                maxLength={40}
                                spellCheck={false}
                                autoComplete="off"
                                aria-invalid={showError ? true : undefined}
                                aria-describedby="username-help"
                                onChange={(e) => {
                                    setDraft(e.target.value);
                                    setResult(null);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void submit();
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        closeEditor();
                                    }
                                }}
                                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-lg font-black text-white outline-none focus:border-white/25"
                            />
                            <button
                                type="button"
                                onClick={() => void submit()}
                                disabled={!validation.ok || busy}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-black transition-all hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                                {busy ? <CircleNotch className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                Save
                            </button>
                            <button
                                type="button"
                                onClick={closeEditor}
                                disabled={busy}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/40 transition-all hover:text-white disabled:opacity-35"
                            >
                                <X className="h-4 w-4" />
                                Cancel
                            </button>
                        </div>
                        <p
                            id="username-help"
                            className={`text-[9px] font-bold uppercase tracking-widest ${showError ? 'text-rose-400' : 'text-white/25'}`}
                        >
                            {showError
                                ? showError.message
                                : validation.ok
                                  ? `Will be registered as ${validation.stored}`
                                  : '2-24 characters · letters, numbers, . _ -'}
                        </p>
                        {result && result.outcome !== 'ok' && (
                            <p className="flex items-start gap-1.5 text-[9px] font-bold uppercase tracking-widest text-rose-400">
                                <WarningCircle className="mt-px h-3 w-3 shrink-0" />
                                {result.message ??
                                    usernameSaveErrorMessage(result.outcome === 'rejected' ? 'taken' : 'network')}
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="group flex items-center gap-3">
                        {!loadedOnce && !display ? (
                            <span aria-label="Loading username" className="h-7 w-36 animate-pulse rounded-lg bg-white/10" />
                        ) : (
                            <h1
                                className={`truncate text-2xl font-black tracking-tighter sm:text-3xl ${
                                    nameUnavailable ? 'text-white/30' : ''
                                }`}
                                data-testid="identity-name"
                            >
                                {/* Text interpolation only: a username is never markup. */}
                                {nameUnavailable ? 'Name unavailable' : display || 'Anonymous Node'}
                            </h1>
                        )}
                        <button
                            type="button"
                            onClick={openEditor}
                            disabled={readOnly}
                            title={readOnly ? readOnlyReason : 'Edit username'}
                            className="rounded-lg p-1.5 text-white/30 opacity-0 transition-all hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                            aria-label="Edit username"
                        >
                            <PencilSimple className="h-4 w-4" />
                        </button>
                        {readOnly && (
                            <span className="text-[8px] font-black uppercase tracking-widest text-white/20">
                                {readOnlyReason}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default IdentityPanel;
