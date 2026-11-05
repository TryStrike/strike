'use client';

import { useState } from 'react';
import { PaperPlaneRight, X } from '@phosphor-icons/react';
import { Button, Field, cx } from '@/components/ui/kit';
import { useCopilot } from '@/lib/copilot/useCopilot';

/** Stays mounted once opened, so the conversation survives closing it. */
export default function CopilotDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { messages, busy, error, send } = useCopilot();
  const [draft, setDraft] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setDraft('');
    send(question);
  };

  return (
    <aside
      aria-label="Copilot"
      hidden={!open}
      className="fixed bottom-20 right-4 z-40 flex h-[min(520px,70vh)] w-[min(380px,calc(100vw-2rem))] flex-col rounded-3xl bg-white text-ink shadow-2xl ring-1 ring-ink/10"
    >
      <header className="flex items-center justify-between px-5 pt-4">
        <h2 className="text-base font-semibold">Copilot</h2>
        <button type="button" aria-label="Close copilot" onClick={onClose} className="text-muted">
          <X size={18} />
        </button>
      </header>
      <ol className="flex-1 space-y-2 overflow-y-auto px-5 py-3 text-sm">
        {messages.length === 0 && <li className="text-faint">Ask what&apos;s moving. It reads live prices and can open a table.</li>}
        {messages.map((m, i) => (
          <li
            key={i}
            className={cx(
              'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2',
              m.role === 'user' ? 'ml-auto bg-ink text-white' : 'bg-surface'
            )}
          >
            {m.content || '…'}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="mx-5 mb-2 rounded-2xl bg-down-soft px-3 py-2 text-xs text-down">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="flex items-center gap-2 px-4 pb-4">
        <Field
          aria-label="Ask the copilot"
          placeholder="What's moving?"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" size="sm" disabled={busy || !draft.trim()} aria-label="Send">
          <PaperPlaneRight size={16} weight="fill" />
        </Button>
      </form>
    </aside>
  );
}
