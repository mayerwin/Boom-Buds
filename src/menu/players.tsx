// Player line-up pieces shared by the Local Game and the network lobby: player and computer-player
// cards, the control set picker, the key capture dialog and "press a key or hold a button to join".

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useMenu, PLAYER_COLOURS } from './ctx.ts';
import { Modal, Stars, SKILL_NAMES } from './ui.tsx';
import { ControllerArt, KeyCluster } from './controller.tsx';
import { JOIN_HOLD_MS, SPLIT_HOLD_MS, type PadJoin } from './nav.ts';
import {
  ACTION_LABELS,
  availableSets,
  canSplit,
  findSet,
  halfOf,
  idsClash,
  isRemoteSet,
  isTvApp,
  keyLabel,
  keysSummary,
  otherHalf,
  padSetId,
  setsClash,
  setForKey,
  TV_REMOTE,
  wholePad,
  type ControlSet,
} from '../app/controls.ts';
import { connectedPads } from '../engine/input.ts';
import type { Game } from '../app/Game.ts';

/** One line describing a control set. */
export function setDescription(s: ControlSet | null): string {
  if (!s) return 'Not available on this device';
  switch (s.kind) {
    case 'keys':
      return keysSummary(s.keys!);
    case 'pad':
      if (isRemoteSet(s)) return 'Arrows move · OK bomb · hold OK special';
      if (s.half === 'left') return 'Left stick or d-pad · LB bomb · LT special';
      if (s.half === 'right') return 'Right stick · A or RB bomb · X or RT special';
      return 'Stick or d-pad · A bomb · B special';
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

/**
 * A card with controls of its own is one stop for the keyboard and the gamepads: Enter goes into it, the arrows
 * then reach its controls, Escape (or an arrow past its edge) comes out (src/menu/nav.ts).
 */
const groupProps = (interactive: boolean, label: string): JSX.HTMLAttributes<HTMLDivElement> =>
  interactive ? ({ tabIndex: 0, 'data-group': '', role: 'group', 'aria-label': label } as JSX.HTMLAttributes<HTMLDivElement>) : { 'aria-label': label };

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
  const what = props.note ?? setDescription(props.set);
  const interactive = !!(props.onColor || props.onPickSet || props.onRemove || (props.team !== undefined && props.onTeam));
  return (
    <div class={cardClass(props.team)} {...groupProps(interactive, `${props.name}${props.set ? `, ${props.set.name}` : ''}: ${what}`)}>
      <div class="stripe" style={{ background: PLAYER_COLOURS[props.slot] }} />
      <Head slot={props.slot} onColor={props.onColor} />
      <div class="who">
        <b>{props.name}</b>
        <span>{what}</span>
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
  const interactive = !!(props.onColor || props.onSkill || props.onRemove || (props.team !== undefined && props.onTeam));
  return (
    <div class={cardClass(props.team)} {...groupProps(interactive, `Computer: ${SKILL_NAMES[props.skill]}`)}>
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
  /** the set the drawing shows: the one being looked at in the list, or else this player's own */
  const [shown, setShown] = useState<string | null>(props.current);
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
  const art = findSet(g.settings.controls, shown ?? props.current ?? sets[0]?.id ?? '');
  return (
    <Modal title="Controls" onClose={props.onClose}>
      {art && (
        <div class="cart-box">
          <h3>{art.name}</h3>
          <ControllerArt set={art} />
        </div>
      )}
      <div class="gamelist">
        {sets.map((s) => {
          const clash = usedSets.find((u) => setsClash(u, s));
          return (
            <button
              class={`btn ${s.id === props.current ? 'primary' : ''}`}
              style={{ justifyContent: 'flex-start', borderRadius: '12px', minHeight: 'calc(var(--tap) * 1.1)' }}
              disabled={!!clash}
              data-autofocus={s.id === props.current ? '' : undefined}
              onFocus={() => setShown(s.id)}
              onMouseEnter={() => setShown(s.id)}
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
        <div class="small muted">
          {isTvApp() ? 'Two players can share a gamepad: one takes its left half, the other its right half.' : 'Gamepads appear here once you press one of their buttons; two players can share one, a half each.'}
        </div>
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

/** Render again when gamepads come and go or a keyboard is first used (their players show or hide). */
export function useDeviceChanges(onChange?: () => void): void {
  const [, redraw] = useState(0);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const bump = () => {
      cb.current?.();
      redraw((x) => x + 1);
    };
    const key = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      window.removeEventListener('keydown', key, true);
      setTimeout(bump, 0);
    };
    window.addEventListener('gamepadconnected', bump);
    window.addEventListener('gamepaddisconnected', bump);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('gamepadconnected', bump);
      window.removeEventListener('gamepaddisconnected', bump);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
}

/** How players join on this device. */
export function joinHint(g: Game): string {
  if (g.app.isTouch && !g.app.input.keyboardSeen) return 'Two players can share this screen: choose “Touch, left side” and “Touch, right side”.';
  if (isTvApp()) return 'To join, hold any button of your gamepad (or OK on the remote) for a moment. Hold one again to share that gamepad between two players: its left half and its right half.';
  return 'To join, press a key of a free keyboard set (like A or the period key), or hold any gamepad button for a moment. Hold one again to share that gamepad between two players.';
}

const MENU_KEYS = ['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** A player joining: their control set, and the new set of the player whose gamepad they share. */
export interface Join {
  id: string;
  swap?: { from: string; to: string };
}

/**
 * "Press a key or hold a button to join": a key of a free keyboard set (its bomb or special key, or any key that
 * is not a menu key) adds a player with that set at once; so does holding any button (not the d-pad, which moves
 * in the menus) of a gamepad that does not play yet, or the TV remote's OK: a short press stays a menu press.
 * A gamepad always joins whole. Holding a button on it again shares it between two players — whoever had it keeps
 * the left half, the newcomer takes the right half, whichever button was held; the first hold on a gamepad that
 * already plays only says so, so that nobody shares one by accident.
 */
export function useJoinListener(enabled: boolean, used: string[], onJoin: (j: Join) => void): void {
  const { g, setJoinHook, toast, sound } = useMenu();
  const usedRef = useRef(used);
  usedRef.current = used;
  const cb = useRef(onJoin);
  cb.current = onJoin;
  /** gamepads that already played when a button on them was held (the next hold shares them) */
  const claimed = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    const prefs = g.settings.controls;
    const free = (id: string) => !usedRef.current.some((u) => idsClash(prefs, u, id));
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.repeat || t instanceof HTMLInputElement) return;
      // the menus' keys work the menus (by position, and by meaning: the numpad's Enter, its arrows without Num Lock)
      if (MENU_KEYS.includes(e.code) || MENU_KEYS.includes(e.key) || e.key === ' ') return;
      const set = setForKey(prefs, e.code);
      if (!set || !free(set.id)) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current({ id: set.id });
    };
    window.addEventListener('keydown', onKey, true);
    setJoinHook({
      candidate(gp, button) {
        // (the d-pad moves in the menus; 16: the home or guide button)
        if (button >= 12) return null;
        const pads = connectedPads();
        const i = pads.findIndex((p) => p.index === gp.index);
        if (i < 0) return null;
        const whole = padSetId(pads, i);
        const label = (id: string) => findSet(prefs, id)?.name ?? id;
        const join = (id: string): PadJoin => ({ id, label: label(id), hold: JOIN_HOLD_MS, hint: `Keep holding to join · ${label(id)}` });
        const users = usedRef.current.filter((u) => wholePad(u) === whole);
        // the remote joins with OK (its Back stays Back), and is never shared
        if (gp.id === TV_REMOTE) return button === 0 && !users.length ? join(whole) : null;
        // nobody on this gamepad yet: it joins whole, whichever button is held
        if (!users.length) return join(whole);
        const said = (claim: string) => ({ id: whole, label: label(whole), hold: JOIN_HOLD_MS, hint: `${label(whole)} already plays · keep holding`, claim });
        // two players share it already, or it is a gamepad whose halves the browser cannot tell apart
        if (users.length > 1) return said(`${label(whole)} is shared by two players already — remove one to have it whole again`);
        if (!canSplit(gp)) return said(`${label(whole)} already plays (this one cannot be shared between two players)`);
        const one = users[0];
        if (one === whole) {
          // the first hold on a gamepad that already plays says so; the next one shares it
          if (!claimed.current.has(whole)) {
            return said(`${label(whole)} already plays — hold a button again to share it between two players`);
          }
          const right = halfOf(whole, 'right');
          return {
            id: right,
            label: label(right),
            hold: SPLIT_HOLD_MS,
            hint: 'Keep holding: two players share this gamepad · its left half and its right half',
            swap: { from: whole, to: halfOf(whole, 'left') },
          };
        }
        // one player has half of it: the newcomer takes the other half
        return free(otherHalf(one)) ? join(otherHalf(one)) : null;
      },
      // (the line-up may have changed since the button went down: the join must still be possible)
      join: (j) => {
        if (j.claim) {
          claimed.current.add(wholePad(j.id));
          sound('ok');
          toast(j.claim);
          return;
        }
        const used = usedRef.current;
        const swap = j.swap;
        const ok = swap ? used.includes(swap.from) && !used.some((u) => u !== swap.from && idsClash(prefs, u, j.id)) : free(j.id);
        if (!ok) return;
        claimed.current.add(wholePad(j.id));
        cb.current({ id: j.id, swap });
      },
    });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setJoinHook(null);
    };
  }, [enabled]);
}
