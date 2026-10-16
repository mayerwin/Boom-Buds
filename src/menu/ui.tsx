// Small building blocks of the menus.

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CODE_ALPHABET } from '../net/room.ts';

/**
 * A setting being changed: Enter (gamepad A) on it starts that, then Left / Right change its value
 * (src/menu/nav.ts); until then the arrows move between the controls.
 */
export function changing(e: Event): boolean {
  return (e.currentTarget as HTMLElement).dataset.editing !== undefined;
}

/** A setting with Left / Right steps (keyboard, gamepad, or the arrow buttons); `asked`: a request to the host. */
export function Stepper<T>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange?: (v: T) => void;
  disabled?: boolean;
  wrap?: boolean;
  asked?: boolean;
}): JSX.Element {
  const { options, value, onChange, disabled } = props;
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  const step = (d: number) => {
    if (disabled || !onChange) return;
    let n = i + d;
    if (props.wrap !== false) n = (n + options.length) % options.length;
    else n = Math.max(0, Math.min(options.length - 1, n));
    if (n !== i) onChange(options[n].value);
  };
  return (
    <div class={`setting ${props.asked ? 'asked' : ''}`}>
      <label>
        {props.label}
        {props.asked && <span class="asked-tag">asked</span>}
      </label>
      <div
        class="stepper"
        tabIndex={disabled || !onChange ? -1 : 0}
        data-edit={disabled || !onChange ? undefined : ''}
        aria-label={props.label}
        onKeyDown={(e) => {
          if (!changing(e)) return;
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        }}
      >
        {onChange && !disabled && <button tabIndex={-1} onClick={() => step(-1)} aria-label="previous">◀</button>}
        <span class="val">{options[i]?.label ?? '?'}</span>
        {onChange && !disabled && <button tabIndex={-1} onClick={() => step(1)} aria-label="next">▶</button>}
      </div>
    </div>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange?: (v: boolean) => void; disabled?: boolean; hint?: string; asked?: boolean }): JSX.Element {
  const off = props.disabled || !props.onChange;
  return (
    <div class={`setting ${props.asked ? 'asked' : ''}`}>
      <label>
        {props.label}
        {props.asked && <span class="asked-tag">asked</span>}
        {props.hint && <div class="small muted">{props.hint}</div>}
      </label>
      <button
        class={`toggle ${props.value ? 'on' : ''}`}
        role="switch"
        aria-checked={props.value}
        aria-label={props.label}
        disabled={off}
        onClick={() => props.onChange?.(!props.value)}
      />
    </div>
  );
}

/** Computer player: the original game's ("1997", skill 0), or Boom Buds' levels, 1 to 5 stars. */
export function Stars(props: { value: number; onChange?: (v: number) => void }): JSX.Element {
  const { value, onChange } = props;
  return (
    <div
      class="stars"
      tabIndex={onChange ? 0 : -1}
      data-edit={onChange ? '' : undefined}
      aria-label={value ? `skill ${value} of 5` : 'the original 1997 computer player'}
      onKeyDown={(e) => {
        if (!onChange || !changing(e)) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(Math.max(0, value - 1)); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onChange(Math.min(5, value + 1)); }
      }}
    >
      <button tabIndex={-1} class={`orig ${value === 0 ? 'on' : ''}`} disabled={!onChange} onClick={() => onChange?.(0)} aria-label="the original 1997 computer player" title="The original game's computer player">
        1997
      </button>
      {[1, 2, 3, 4, 5].map((n) => (
        <button tabIndex={-1} class={n <= value ? 'on' : ''} disabled={!onChange} onClick={() => onChange?.(n)} aria-label={`${n} stars`}>
          ★
        </button>
      ))}
    </div>
  );
}

export const SKILL_NAMES = ['Original 1997', 'Rookie', 'Casual', 'Skilled', 'Expert', 'Master'];

/** A dialog over the current screen; Escape / B closes it. */
export function Modal(props: { title: string; children: ComponentChildren; onClose?: () => void; wide?: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // the dialog's preferred control, else its first one but the ✕ (OK / A must not close a dialog that just opened)
    const el = ref.current;
    const all = el ? [...el.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"], input:not([disabled])')] : [];
    const first = el?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ?? all.find((e) => !e.matches('h2 button')) ?? all[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && props.onClose) {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);
  return (
    <div class="modal-wrap" onClick={(e) => { if (e.target === e.currentTarget) props.onClose?.(); }}>
      <div class="panel modal" ref={ref} style={props.wide ? { width: 'min(820px, 94vw)' } : undefined}>
        <h2>
          <span class="grow">{props.title}</span>
          {props.onClose && <button class="btn icon ghost small" onClick={props.onClose} aria-label="close">✕</button>}
        </h2>
        {props.children}
      </div>
    </div>
  );
}

/** Pick one item in a list (dialog). */
export function Picker<T>(props: {
  title: string;
  items: { value: T; label: string; sub?: string; disabled?: boolean }[];
  current?: T;
  onPick: (v: T) => void;
  onClose: () => void;
  extra?: ComponentChildren;
}): JSX.Element {
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div class="gamelist">
        {props.items.map((it) => (
          <button
            class={`btn ${it.value === props.current ? 'primary' : ''}`}
            style={{ justifyContent: 'flex-start', borderRadius: '12px' }}
            disabled={it.disabled}
            data-autofocus={it.value === props.current ? '' : undefined}
            onClick={() => props.onPick(it.value)}
          >
            <span>{it.label}</span>
            {it.sub && <span class="small muted" style={{ marginLeft: 'auto' }}>{it.sub}</span>}
          </button>
        ))}
        {props.extra}
      </div>
    </Modal>
  );
}

/** Six boxes for a room code; typing or pasting fills them, Enter submits. */
export function CodeInput(props: { onSubmit: (code: string) => void; autofocus?: boolean }): JSX.Element {
  const [chars, setChars] = useState<string[]>(['', '', '', '', '', '']);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const set = (from: number, text: string) => {
    // only the symbols room codes are made of (no look-alikes such as 0 / O or 1 / I / L)
    const clean = [...text.toUpperCase()].filter((ch) => CODE_ALPHABET.includes(ch)).join('');
    if (!clean) return;
    const next = [...chars];
    let k = from;
    for (const ch of clean) {
      if (k > 5) break;
      next[k++] = ch;
    }
    setChars(next);
    refs.current[Math.min(k, 5)]?.focus();
    if (next.every(Boolean) && k > 5) props.onSubmit(next.join(''));
  };
  return (
    <div class="codebox" aria-label="room code">
      {chars.map((c, i) => (
        <input
          ref={(el) => { refs.current[i] = el; }}
          value={c}
          maxLength={6}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellcheck={false}
          data-autofocus={props.autofocus && i === 0 ? '' : undefined}
          aria-label={`code letter ${i + 1}`}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            if (!v) {
              const next = [...chars];
              next[i] = '';
              setChars(next);
            } else set(i, v.slice(v.length > 1 && c ? 1 : 0));
          }}
          onPaste={(e) => {
            e.preventDefault();
            set(0, e.clipboardData?.getData('text') ?? '');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !chars[i] && i > 0) {
              e.preventDefault();
              const next = [...chars];
              next[i - 1] = '';
              setChars(next);
              refs.current[i - 1]?.focus();
            } else if (e.key === 'Enter' && chars.every(Boolean)) {
              e.preventDefault();
              props.onSubmit(chars.join(''));
            } else if (e.key === 'ArrowLeft' && i > 0) {
              e.preventDefault();
              refs.current[i - 1]?.focus();
            } else if (e.key === 'ArrowRight' && i < 5) {
              e.preventDefault();
              refs.current[i + 1]?.focus();
            }
          }}
        />
      ))}
    </div>
  );
}

/** Transient message at the bottom of the screen. */
export function Toast(props: { text: string; bad?: boolean }): JSX.Element {
  return <div class={`toast ${props.bad ? 'bad' : ''}`} role="status">{props.text}</div>;
}
