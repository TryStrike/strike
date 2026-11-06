'use client';

import { useCallback, useState } from 'react';
import { dispatch, useCopilotView } from './actions';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const KEEP = 10;

/** The last turns the server takes: at most 10, starting with the trader. */
function history(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.filter((m) => m.content.trim()).slice(-KEEP);
  while (recent[0]?.role === 'assistant') recent.shift();
  return recent;
}

export function useCopilot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appendAnswer = (text: string) =>
    setMessages((all) => {
      const last = all[all.length - 1];
      return [...all.slice(0, -1), { ...last, content: last.content + text }];
    });

  const send = useCallback(
    async (question: string) => {
      const asked = [...messages, { role: 'user' as const, content: question }];
      setMessages([...asked, { role: 'assistant', content: '' }]);
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/copilot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: history(asked), ticketOpen: useCopilotView.getState().ticket !== null }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          setError(body?.error ?? `Copilot failed with ${res.status}`);
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
            if (event === 'text') appendAnswer(payload.text);
            else if (event === 'action') {
              try {
                dispatch(payload);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Copilot action failed');
              }
            }
            else if (event === 'error') setError(payload.error);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Copilot failed');
      } finally {
        setMessages((all) => all.filter((m) => m.content.trim()));
        setBusy(false);
      }
    },
    [messages]
  );

  return { messages, busy, error, send };
}
