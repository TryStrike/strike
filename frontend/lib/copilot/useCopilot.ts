import { create } from 'zustand';
import type { ToolStep } from '@/lib/agent/agentFeed';
import { dispatch } from './actions';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** What the stream shows when it isn't what the model was asked. */
  label?: string;
  at: number;
  steps?: ToolStep[];
}

const KEEP = 10;

/** The last turns the server takes: at most 10, starting with the trader. */
function history(messages: ChatMessage[]) {
  const recent = messages.filter((m) => m.content.trim()).slice(-KEEP);
  while (recent[0]?.role === 'assistant') recent.shift();
  return recent.map(({ role, content }) => ({ role, content }));
}

interface CopilotChat {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  send: (question: string, label?: string) => Promise<void>;
  clear: () => void;
}

export const useCopilot = create<CopilotChat>((set, get) => {
  let asking: AbortController | null = null;
  const onLast = (change: (last: ChatMessage) => ChatMessage) =>
    set((s) => ({ messages: [...s.messages.slice(0, -1), change(s.messages[s.messages.length - 1])] }));

  return {
    messages: [],
    busy: false,
    error: null,
    clear: () => {
      asking?.abort();
      set({ messages: [], error: null, busy: false });
    },
    send: async (question, label) => {
      if (get().busy) return;
      const mine = new AbortController();
      asking = mine;
      const asked = [...get().messages, { role: 'user' as const, content: question, label, at: Date.now() }];
      set({ messages: [...asked, { role: 'assistant', content: '', at: Date.now() }], busy: true, error: null });
      try {
        const res = await fetch('/api/copilot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: history(asked) }),
          signal: mine.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          set({ error: body?.error ?? `Copilot failed with ${res.status}` });
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (!event || !data) continue;
            const payload = JSON.parse(data);
            if (event === 'text') onLast((last) => ({ ...last, content: last.content + payload.text }));
            else if (event === 'tool') onLast((last) => ({ ...last, steps: [...(last.steps ?? []), payload] }));
            else if (event === 'action') {
              try {
                dispatch(payload);
              } catch (e) {
                set({ error: e instanceof Error ? e.message : 'Copilot action failed' });
              }
            } else if (event === 'error') set({ error: payload.error });
          }
        }
      } catch (e) {
        if (!mine.signal.aborted) set({ error: e instanceof Error ? e.message : 'Copilot failed' });
      } finally {
        if (!mine.signal.aborted) {
          set((s) => ({ messages: s.messages.filter((m) => m.content.trim() || m.steps?.length), busy: false }));
        }
      }
    },
  };
});
