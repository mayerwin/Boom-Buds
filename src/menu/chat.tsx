// The chat of a network game's lobby: messages to everybody in the room (emoji welcome), the requests of the
// players who are not the host (the host grants one with a click), and who came and who left.

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LobbyModel } from './lobbyModel.ts';

const EMOJIS = ['😀', '😂', '😎', '😉', '🤔', '😮', '😱', '😡', '😭', '😴', '👍', '👎', '👏', '🙏', '🤝', '👀', '🔥', '💣', '💥', '💀', '🏆', '🎉', '❤️', '🍕'];

export function LobbyChat(props: { model: LobbyModel }): JSX.Element {
  const { model } = props;
  const [text, setText] = useState('');
  const [emojis, setEmojis] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lines = model.chat;
  const last = lines[lines.length - 1];
  // the newest line in view
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, last?.id, last?.text, last?.done]);
  const send = () => {
    if (!text.trim()) return;
    model.say(text);
    setText('');
    setEmojis(false);
  };
  const insert = (e: string) => {
    const el = input.current;
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? a;
    setText(text.slice(0, a) + e + text.slice(b));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + e.length, a + e.length);
    });
  };
  return (
    <div class="panel chat">
      <div class="chat-lines" ref={list} role="log" aria-label="chat">
        {!lines.length && <div class="muted">Messages go to everybody in the room. Say hello! 👋</div>}
        {lines.map((l) => (
          <div class={`chat-line ${l.kind}${l.done ? ' done' : ''}`} key={l.id}>
            {l.kind === 'say' && (
              <>
                <b>{l.name}</b> {l.text}
              </>
            )}
            {l.kind === 'info' && l.text}
            {l.kind === 'ask' && (
              <>
                <span aria-hidden="true">🙋</span>
                <span class="grow">
                  <b>{l.name}</b> would like: {l.text}
                </span>
                {l.done ? (
                  <span class="granted">✓ done</span>
                ) : model.isHost ? (
                  <button class="btn small" onClick={() => model.grant(l.id)}>Apply</button>
                ) : (
                  <span class="pending">waiting for the host</span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div class="chat-input">
        <button class={`btn small icon ghost ${emojis ? 'on' : ''}`} aria-label="emojis" aria-expanded={emojis} onClick={() => setEmojis(!emojis)}>
          😀
        </button>
        <input
          ref={input}
          class="textin"
          value={text}
          maxLength={200}
          placeholder="Say something…"
          aria-label="chat message"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              // (the lobby's Escape leaves the room: here it only leaves the text field)
              e.preventDefault();
              setEmojis(false);
              input.current?.blur();
            }
          }}
        />
        <button class="btn small primary" disabled={!text.trim()} onClick={send}>Send</button>
        {emojis && (
          <div class="emoji-pop">
            {EMOJIS.map((e) => (
              <button class="emoji" aria-label={e} onClick={() => insert(e)}>{e}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
