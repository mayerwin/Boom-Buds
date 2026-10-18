// What a control set looks like: a drawing of the controller with the buttons this player uses lit up, and a
// legend naming them (LB and LT mean nothing until you have seen where they are). Shown when the controls of a
// player are chosen — tap the controls button on a player's card — and in the Controls menu.

import type { JSX } from 'preact';
import { ACTION_LABELS, isRemoteSet, keyLabel, type ControlSet } from '../app/controls.ts';
import type { PadHalf } from '../engine/input.ts';

/** The three things a bomber is told to do, in the colours the drawing and its legend share. */
const ROLES = ['move', 'bomb', 'special'] as const;
type Role = (typeof ROLES)[number];

/** Parts of the drawing a set uses, by role (a part not named here is drawn dimmed). */
type Parts = Partial<Record<string, Role>>;

/** The six keys of a keyboard set laid out like a d-pad plus two buttons; `ask` marks the key being recorded. */
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

/** Which parts of a gamepad a whole pad, or one half of it, plays with. */
function padParts(half?: PadHalf): Parts {
  if (half === 'left') return { stick: 'move', dpad: 'move', LB: 'bomb', LT: 'special' };
  if (half === 'right') return { rstick: 'move', A: 'bomb', RB: 'bomb', X: 'special', RT: 'special' };
  return { stick: 'move', dpad: 'move', rstick: 'move', A: 'bomb', X: 'bomb', B: 'special', Y: 'special' };
}

/** What the legend says under the drawing, by role. */
function padLegend(half?: PadHalf): Record<Role, string> {
  if (half === 'left') return { move: 'left stick or d-pad', bomb: 'LB', special: 'LT' };
  if (half === 'right') return { move: 'right stick', bomb: 'A or RB', special: 'X or RT' };
  return { move: 'either stick or the d-pad', bomb: 'A or X', special: 'B or Y' };
}

function Legend(props: { what: Record<Role, string> }): JSX.Element {
  return (
    <div class="cart-legend">
      {ROLES.map((r) => (
        <span class={`cart-key ${r}`}>
          <i />
          <b>{r === 'move' ? 'Move' : r === 'bomb' ? 'Bomb' : 'Special'}</b>
          {props.what[r]}
        </span>
      ))}
    </div>
  );
}

/** A gamepad, or one half of it: the parts this player uses are lit and named. */
function Gamepad(props: { half?: PadHalf }): JSX.Element {
  const parts = padParts(props.half);
  const cls = (id: string) => `part ${parts[id] ? `on ${parts[id]}` : 'off'}`;
  const face = (id: string) => `cart-face ${parts[id] ? 'on' : ''}`;
  const label = (id: string, x: number, y: number) =>
    parts[id] ? (
      <text class={`cart-label ${parts[id]}`} x={x} y={y} text-anchor="middle">
        {id}
      </text>
    ) : null;
  return (
    <svg class="cart-svg" viewBox="0 0 240 150" role="img" aria-label={`gamepad${props.half ? `, ${props.half} half` : ''}`}>
      <defs>
        <linearGradient id="cart-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#4a4080" />
          <stop offset="1" stop-color="#241c48" />
        </linearGradient>
      </defs>
      {/* half a gamepad: the side this player holds */}
      {props.half && (
        <rect
          class={`cart-side ${props.half}`}
          x={props.half === 'left' ? 4 : 120}
          y="4"
          width="116"
          height="142"
          rx="14"
        />
      )}
      <path
        class="cart-shell"
        fill="url(#cart-body)"
        d="M40 38C16 38 6 62 12 96c5 27 17 42 35 38 16-4 27-14 51-16h44c24 2 35 12 51 16 18 4 30-11 35-38 6-34-4-58-28-58-24 0-44 10-80 10S64 38 40 38Z"
      />
      {/* triggers and bumpers */}
      <rect class={cls('LT')} x="42" y="6" width="34" height="13" rx="6" />
      <rect class={cls('RT')} x="164" y="6" width="34" height="13" rx="6" />
      {label('LT', 59, 16)}
      {label('RT', 181, 16)}
      <rect class={cls('LB')} x="38" y="22" width="42" height="14" rx="7" />
      <rect class={cls('RB')} x="160" y="22" width="42" height="14" rx="7" />
      {label('LB', 59, 33)}
      {label('RB', 181, 33)}
      {/* sticks */}
      <circle class={`cart-well ${parts.stick ? 'on' : 'off'}`} cx="64" cy="70" r="20" />
      <circle class={cls('stick')} cx="64" cy="70" r="13" />
      <circle class={`cart-well ${parts.rstick ? 'on' : 'off'}`} cx="146" cy="100" r="20" />
      <circle class={cls('rstick')} cx="146" cy="100" r="13" />
      {/* d-pad */}
      <path class={cls('dpad')} d="M98 88h12v-12h12v12h12v12h-12v12h-12v-12H98Z" transform="translate(-6 -6)" />
      {/* view and menu (they pause a round) */}
      <circle class="part off" cx="94" cy="54" r="5" />
      <circle class="part off" cx="116" cy="54" r="5" />
      {/* face buttons (the letter on a lit one is dark: it has to be read on gold or pink) */}
      <circle class={cls('Y')} cx="182" cy="56" r="11" />
      <circle class={cls('X')} cx="164" cy="74" r="11" />
      <circle class={cls('B')} cx="200" cy="74" r="11" />
      <circle class={cls('A')} cx="182" cy="92" r="11" />
      <text class={face('Y')} x="182" y="60" text-anchor="middle">Y</text>
      <text class={face('X')} x="164" y="78" text-anchor="middle">X</text>
      <text class={face('B')} x="200" y="78" text-anchor="middle">B</text>
      <text class={face('A')} x="182" y="96" text-anchor="middle">A</text>
    </svg>
  );
}

/** The TV remote: its arrows walk, OK drops a bomb and a held OK is the special. */
function Remote(): JSX.Element {
  return (
    <svg class="cart-svg remote" viewBox="0 0 120 220" role="img" aria-label="TV remote">
      <rect class="cart-shell" x="22" y="6" width="76" height="208" rx="34" />
      <circle class="cart-well on" cx="60" cy="74" r="40" />
      <path class="part on move" d="M60 40l10 14H50Z" />
      <path class="part on move" d="M60 108l10-14H50Z" />
      <path class="part on move" d="M26 74l14-10v20Z" />
      <path class="part on move" d="M94 74l-14-10v20Z" />
      <circle class="part on bomb" cx="60" cy="74" r="19" />
      <text class="cart-face" x="60" y="79" text-anchor="middle">OK</text>
      <circle class="part off" cx="38" cy="140" r="13" />
      <text class="cart-label off" x="38" y="167" text-anchor="middle">Back</text>
      <circle class="part off" cx="82" cy="140" r="13" />
    </svg>
  );
}

/** A phone or tablet: the on-screen stick and buttons. */
function Touch(props: { side?: 'both' | 'left' | 'right' }): JSX.Element {
  const side = props.side ?? 'both';
  return (
    <svg class="cart-svg touch" viewBox="0 0 240 150" role="img" aria-label="on-screen controls">
      <rect class="cart-shell" x="6" y="10" width="228" height="130" rx="14" />
      {side !== 'right' && (
        <>
          <circle class="cart-well on" cx="52" cy="92" r="26" />
          <circle class="part on move" cx="52" cy="92" r="14" />
        </>
      )}
      {side !== 'left' && (
        <>
          <circle class="part on bomb" cx="178" cy="100" r="15" />
          <circle class="part on special" cx="210" cy="74" r="15" />
        </>
      )}
      {side === 'left' && <text class="cart-label off" x="170" y="96" text-anchor="middle">other player</text>}
      {side === 'right' && <text class="cart-label off" x="70" y="96" text-anchor="middle">other player</text>}
    </svg>
  );
}

/** The mouse: the bomber walks toward the pointer. */
function Mouse(): JSX.Element {
  return (
    <svg class="cart-svg mouse" viewBox="0 0 120 170" role="img" aria-label="mouse">
      <path class="cart-shell" d="M60 6c30 0 44 24 44 64s-14 94-44 94-44-54-44-94S30 6 60 6Z" />
      <path class="part on bomb" d="M60 8c-28 1-41 24-42 56h42Z" />
      <path class="part on special" d="M60 8c28 1 41 24 42 56H60Z" />
      <text class="cart-label bomb" x="34" y="44" text-anchor="middle">Bomb</text>
      <text class="cart-label special" x="86" y="44" text-anchor="middle">Special</text>
      <text class="cart-label off" x="60" y="112" text-anchor="middle">point to</text>
      <text class="cart-label off" x="60" y="128" text-anchor="middle">walk</text>
    </svg>
  );
}

/**
 * The drawing of a control set with its legend. `lit`: keyboard keys held right now (the Controls menu lights
 * them up as they are pressed).
 */
export function ControllerArt(props: { set: ControlSet | null; lit?: Set<string> }): JSX.Element | null {
  const s = props.set;
  if (!s) return null;
  if (s.kind === 'keys') {
    return (
      <div class="cart keys">
        <KeyCluster keys={s.keys ?? []} lit={props.lit} />
      </div>
    );
  }
  if (s.kind === 'mouse') {
    return (
      <div class="cart">
        <Mouse />
        <Legend what={{ move: 'point where to walk', bomb: 'left button', special: 'right button' }} />
      </div>
    );
  }
  if (s.kind === 'touch') {
    return (
      <div class="cart">
        <Touch side={s.side} />
        <Legend
          what={{
            move: s.side === 'right' ? 'the right-hand stick' : 'the stick on screen',
            bomb: 'the big button',
            special: 'the second button',
          }}
        />
      </div>
    );
  }
  if (isRemoteSet(s)) {
    return (
      <div class="cart">
        <Remote />
        <Legend what={{ move: 'the arrows', bomb: 'OK', special: 'hold OK' }} />
      </div>
    );
  }
  return (
    <div class="cart">
      <Gamepad half={s.half} />
      <Legend what={padLegend(s.half)} />
    </div>
  );
}
