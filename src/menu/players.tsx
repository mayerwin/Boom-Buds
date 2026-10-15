// Player line-up pieces shared by the Local Game and the network lobby: player and computer-player
// cards, the control set picker, the key capture dialog and "press a key or button to join".

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useMenu, PLAYER_COLOURS } from './ctx.ts';
import { Modal, Stars, SKILL_NAMES } from './ui.tsx';
import {
  ACTION_LABELS,
  availableSets,
  findSet,
  isTvApp,
  keyLabel,
  keysSummary,
  setsClash,
  setForKey,
  TV_REMOTE,
  type ControlSet,
} from '../app/controls.ts';

/** The six keys of a set laid out like a d-pad plus two buttons; `ask` marks the key being recorded. */
export function KeyCluster(props: { keys: (string | undefined)[]; lit?: Set<string>; ask?: number }): JSX.Element {
  const cap = (i: number, cls: string) => (
    <div class={`key ${cls}`}>
      <kbd class={props.ask === i ? 'ask' : props.keys[i] && props.lit?.has(props.keys[i]!) ? 'lit' : props.keys[i] && props.ask !== undefined ? 'lit' : ''}>
        {props.keys[i] ? keyLabel(props.keys[i]!) : '?'}
      </kbd>
      {ACTION_LABELS[i]}
    </div>
  );
  return (
    <div class="cluster">
      <div class="dpad">
        {cap(0, 'up')}
        {cap(3, 'left')}
        {cap(2, 'down')}
        {cap(1, 'right')}
      </div>
      <div class="acts">
        {cap(4, '')}
        {cap(5, '')}
      </div>
    </div>
  );
}

/** One line describing a control set. */
export function setDescription(s: ControlSet | null): string {
  if (!s) return 'Not available on this device';
  switch (s.kind) {
    case 'keys':
      return keysSummary(s.keys!);
    case 'pad':
      return s.name === TV_REMOTE ? 'Arrows move · OK bomb · hold OK special' : 'Stick or d-pad · A bomb · B special';
    case 'mouse':
      return 'Point to walk · left bomb · right special';
    case 'touch':
      return s.side === 'both' ? 'On-screen stick and buttons' : `Stick and buttons on the ${s.side} side`;
  }
}

export const COLOUR_NAMES = ['White', 'Black', 'Red', 'Blue', 'Green', 'Yellow', 'Cyan', 'Pink', 'Orange', 'Purple'];

/** The bomber of a card; a button that changes the colour when the player may. */
function Head(props: { slot: number; onColor?: () => void }): JSX.Element {
  const { art } = useMenu();
  const style = { backgroundImage: `url(${art.bombers[props.slot]})` };
  return props.onColor ? (
    <button class="head pick" style={style} onClick={props.onColor} aria-label={`colour: ${COLOUR_NAMES[props.slot]}, change`} title="Change colour" />
  ) : (
    <div class="head" style={style} aria-label={COLOUR_NAMES[props.slot]} />
  );
}

/** Team games: a card is tinted with its team (white or red); this button moves the player to the other one. */
function TeamSwitch(props: { team: number; onTeam?: () => void }): JSX.Element | null {
  if (!props.onTeam) return null;
  const other = props.team === 0 ? 'red' : 'white';
  return (
    <button class={`team-swap to-${other}`} onClick={props.onTeam} aria-label={`move to the ${other} team`} title={`Move to the ${other} team`}>
      ⇄
    </button>
  );
}

/** The card's classes: tinted white or red in team games. */
const cardClass = (team?: number) => (team === undefined ? 'pcard' : `pcard team-${team}`);

export function PlayerCard(props: {
  slot: number;
  name: string;
  set: ControlSet | null;
  team?: number;
  onTeam?: () => void;
  onColor?: () => void;
  onPickSet?: () => void;
  onRemove?: () => void;
  note?: string;
}): JSX.Element {
  return (
    <div class={cardClass(props.team)}>
      <div class="stripe" style={{ background: PLAYER_COLOURS[props.slot] }} />
      <Head slot={props.slot} onColor={props.onColor} />
      <div class="who">
        <b>{props.name}</b>
        <span>{props.note ?? setDescription(props.set)}</span>
      </div>
      <div class="acts">
        {props.team !== undefined && <TeamSwitch team={props.team} onTeam={props.onTeam} />}
        {props.onPickSet && (
          <button class="btn small" onClick={props.onPickSet} aria-label={`controls of ${props.name}`}>
            {props.set?.name ?? 'Choose'}
          </button>
        )}
      </div>
      {props.onRemove && <button class="btn small icon ghost x" onClick={props.onRemove} aria-label={`remove ${props.name}`}>✕</button>}
    </div>
  );
}

export function BotCard(props: {
  slot: number;
  skill: number;
  team?: number;
  onTeam?: () => void;
  onColor?: () => void;
  onSkill?: (v: number) => void;
  onRemove?: () => void;
}): JSX.Element {
  return (
    <div class={cardClass(props.team)}>
      <div class="stripe" style={{ background: PLAYER_COLOURS[props.slot] }} />
      <Head slot={props.slot} onColor={props.onColor} />
      <div class="who">
        <b>Computer</b>
        <span>{SKILL_NAMES[props.skill]}</span>
      </div>
      <div class="acts">
        {props.team !== undefined && <TeamSwitch team={props.team} onTeam={props.onTeam} />}
        <Stars value={props.skill} onChange={props.onSkill} />
      </div>
      {props.onRemove && <button class="btn small icon ghost x" onClick={props.onRemove} aria-label="remove computer player">✕</button>}
    </div>
  );
}

/** Team games: how many play for each team, and whether that is even. */
export function TeamBalance(props: { white: number; red: number }): JSX.Element {
  const { white, red } = props;
  const d = white - red;
  const n = Math.abs(d);
  const note = d === 0 ? 'Even teams' : `${d > 0 ? 'White' : 'Red'} has ${n} player${n === 1 ? '' : 's'} more`;
  return (
    <div class={`balance ${d === 0 ? 'even' : 'uneven'}`} role="status" aria-label={`teams: ${white} white, ${red} red. ${note}`}>
      <span class="side white">White {white}</span>
      <span class="side red">Red {red}</span>
      <small>{d === 0 ? '✓ ' : '⚠ '}{note}</small>
    </div>
  );
}

/** Choose a bomber colour; colours of other people are taken (computer players make room). */
export function ColorPicker(props: { current: number; takenBy: (string | null)[]; onPick: (color: number) => void; onClose: () => void }): JSX.Element {
  const { art } = useMenu();
  return (
    <Modal title="Choose a colour" onClose={props.onClose}>
      <div class="colours">
        {COLOUR_NAMES.map((name, i) => {
          const by = i === props.current ? null : props.takenBy[i];
          return (
            <button
              class={`colour ${i === props.current ? 'on' : ''}`}
              disabled={!!by}
              data-autofocus={i === props.current ? '' : undefined}
              onClick={() => props.onPick(i)}
              aria-label={by ? `${name}, taken by ${by}` : name}
            >
              <span class="bomber" style={{ backgroundImage: `url(${art.bombers[i]})` }} />
              <small>{by ?? name}</small>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/** Choose the control set of a player; offers to create a keyboard set on the spot. */
export function ControlPicker(props: {
  current: string | null;
  used: string[];
  onPick: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { g, save } = useMenu();
  const [capture, setCapture] = useState(false);
  const sets = availableSets(g.settings.controls, g.app.input, g.app.isTouch);
  const usedSets = props.used.filter((id) => id !== props.current).map((id) => findSet(g.settings.controls, id)).filter(Boolean) as ControlSet[];
  if (capture) {
    return (
      <KeyCapture
        onDone={(set) => {
          g.settings.controls.sets.push(set);
          save();
          props.onPick(set.id);
        }}
        onClose={() => setCapture(false)}
      />
    );
  }
  return (
    <Modal title="Controls" onClose={props.onClose}>
      <div class="gamelist">
        {sets.map((s) => {
          const clash = usedSets.find((u) => setsClash(u, s));
          return (
            <button
              class={`btn ${s.id === props.current ? 'primary' : ''}`}
              style={{ justifyContent: 'flex-start', borderRadius: '12px', minHeight: 'calc(var(--tap) * 1.1)' }}
              disabled={!!clash}
              data-autofocus={s.id === props.current ? '' : undefined}
              onClick={() => props.onPick(s.id)}
            >
              <span>{s.name}</span>
              <span class="small muted" style={{ marginLeft: 'auto', fontFamily: 'system-ui' }}>{clash ? 'in use' : setDescription(s)}</span>
            </button>
          );
        })}
        {!g.app.isTouch || g.app.input.keyboardSeen ? (
          <button class="btn ghost" style={{ borderRadius: '12px', borderStyle: 'dashed' }} onClick={() => setCapture(true)}>
            ＋ New keyboard controls…
          </button>
        ) : null}
        <div class="small muted">Gamepads appear here once you press one of their buttons.</div>
      </div>
    </Modal>
  );
}

/**
 * Record a keyboard set: press the key for each action in turn. `initial` edits an existing set.
 */
export function KeyCapture(props: { initial?: ControlSet; onDone: (s: ControlSet) => void; onClose: () => void }): JSX.Element {
  const { g, sound } = useMenu();
  const [keys, setKeys] = useState<string[]>([]);
  const [warn, setWarn] = useState('');
  const keysRef = useRef<string[]>([]);
  keysRef.current = keys;
  const done = keys.length >= 6;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysRef.current.length >= 6) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') return props.onClose();
      if (!e.code || e.code === 'MetaLeft' || e.code === 'MetaRight') return;
      if (keysRef.current.includes(e.code)) {
        setWarn(`${keyLabel(e.code)} is already used for ${ACTION_LABELS[keysRef.current.indexOf(e.code)]}.`);
        sound('no');
        return;
      }
      const other = g.settings.controls.sets.find((s) => s.kind === 'keys' && s.id !== props.initial?.id && s.keys!.includes(e.code));
      setWarn(other ? `Note: ${keyLabel(e.code)} is also used by “${other.name}”.` : '');
      sound('move');
      setKeys([...keysRef.current, e.code]);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const name = props.initial?.name ?? `Keyboard ${g.settings.controls.sets.filter((s) => s.kind === 'keys').length + 1}`;
  return (
    <Modal title={props.initial ? `Change ${props.initial.name}` : 'New keyboard controls'} onClose={props.onClose}>
      <div class="muted">{done ? 'All set. Save these controls?' : <>Press the key for <b style={{ color: 'var(--accent-2)' }}>{ACTION_LABELS[keys.length]}</b> (Esc cancels)</>}</div>
      <KeyCluster keys={keys} ask={done ? undefined : keys.length} />
      <div class="status">{warn}</div>
      <div class="row">
        <button class="btn ghost" onClick={() => { setKeys([]); setWarn(''); }} disabled={!keys.length}>Start over</button>
        <span class="spacer" />
        <button
          class="btn primary"
          disabled={!done}
          data-autofocus=""
          onClick={() => props.onDone({ id: props.initial?.id ?? `kb-${Date.now().toString(36)}`, name, kind: 'keys', keys, builtin: props.initial?.builtin })}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/**
 * "Press a key or button to join": a key of a free keyboard set (its bomb or special key, or any key that
 * is not a menu key), or a button of a gamepad that is not playing yet, adds a player with that set.
 */
export function useJoinListener(enabled: boolean, used: string[], onJoin: (id: string) => void): void {
  const { g, setPadHook } = useMenu();
  const usedRef = useRef(used);
  usedRef.current = used;
  const cb = useRef(onJoin);
  cb.current = onJoin;
  useEffect(() => {
    if (!enabled) return;
    const free = (id: string) => {
      const s = findSet(g.settings.controls, id);
      if (!s) return false;
      return !usedRef.current.some((u) => {
        const o = findSet(g.settings.controls, u);
        return o ? setsClash(o, s) : false;
      });
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.repeat || t instanceof HTMLInputElement) return;
      if (['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
      const set = setForKey(g.settings.controls, e.code);
      if (!set || !free(set.id)) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current(set.id);
    };
    window.addEventListener('keydown', onKey, true);
    setPadHook((order, button) => {
      if (order < 0 || !free(`pad-${order}`)) return false;
      if (button > 3 && button !== 9) return false;
      // the TV remote drives the menus: its OK clicks, it does not join (Add player can still pick it)
      if (isTvApp() && g.app.input.gamepads()[order]?.id === TV_REMOTE) return false;
      cb.current(`pad-${order}`);
      return true;
    });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setPadHook(null);
    };
  }, [enabled]);
}
