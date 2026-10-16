// Local Game: players on this device (keyboard sets, gamepads or halves of them, the TV remote, the mouse, touch
// controls) plus computer players, each with a colour and a team they can change, the arena and the rules. The
// line-up is kept as it changes (src/menu/lineup.ts), for the next visit and for the original menus' player
// setup: a player whose device is not there waits, hidden, and comes back with it.

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { RulesPanel, applyRules, rulesFromSettings, type Rules } from './rules.tsx';
import { BotCard, ColorPicker, ControlPicker, PlayerCard, TeamBalance, joinHint, useDeviceChanges, useJoinListener, type Join } from './players.tsx';
import {
  availableIds,
  lineupSlots,
  NO_LOOK,
  placeLineup,
  playingNow,
  savedLineup,
  schemeTeams,
  storeLineup,
  teamFor,
  withColor,
  withTeam,
  type Bot,
  type Human,
} from './lineup.ts';
import { availableSets, findSet, idsClash, isRemoteSet, isTouchOnly, isTvApp, mergeHalves, setName } from '../app/controls.ts';
import { AI_DEFAULT, INPUT_OFF } from '../app/session.ts';
import type { Look } from '../app/settings.ts';
import type { Game } from '../app/Game.ts';

/** The first player of a device: a gamepad on a TV (else its remote), touch controls on a phone, the arrow keys elsewhere. */
export function firstPlayer(g: Game): Human {
  const pads = availableSets(g.settings.controls, g.app.input, g.app.isTouch).filter((s) => s.kind === 'pad' && !s.half);
  const tvPad = isTvApp() ? (pads.find((s) => !isRemoteSet(s)) ?? pads[0])?.id : undefined;
  return { ctl: tvPad ?? (g.app.isTouch || isTouchOnly() ? 'touch' : 'kb-arrows'), look: NO_LOOK };
}

/** The kept line-up (every player, also those whose device is not there now); the first time, the first player. */
export function initialLineup(g: Game): { players: Human[]; bots: Bot[] } {
  const saved = savedLineup(g);
  return saved.players.length ? saved : { players: [firstPlayer(g)], bots: saved.bots };
}

/**
 * The last Local Game line-up, if it can be played again right away (with the players whose device is there:
 * at least one person, and two players in all): a short description, after filling session.slots when `apply`.
 */
export function quickMatchSlots(g: Game, apply: boolean): string {
  const st = g.settings;
  if (!st.localPlayers.length) return '';
  const saved = savedLineup(g);
  const players = playingNow(g, saved.players, saved.bots.length);
  const bots = saved.bots;
  if (!players.length || players.length + bots.length < 2) return '';
  const slots = lineupSlots(g, players, bots, st.schemefilename);
  if (st.team_play && new Set(slots.filter((s) => s.type !== INPUT_OFF).map((s) => s.team)).size < 2) return '';
  if (apply) g.session.slots = slots;
  const p = players.length === 1 ? '1 player' : `${players.length} players`;
  return bots.length ? `${p} + ${bots.length} computer${bots.length > 1 ? 's' : ''}` : p;
}

export function LocalGame(): JSX.Element {
  const { g, back, exit, save, toast, sound } = useMenu();
  const st = g.settings;
  const [initial] = useState(() => initialLineup(g));
  const [players, setPlayers] = useState<Human[]>(initial.players);
  const [bots, setBots] = useState<Bot[]>(initial.bots);
  const [rules, setRules] = useState<Rules>(() => rulesFromSettings(st));
  /** whose controls are being chosen ('add': a new player's) */
  const [picker, setPicker] = useState<Human | 'add' | null>(null);
  /** colour being chosen: index in the players who play now, then in the computer players */
  const [colorFor, setColorFor] = useState<number | null>(null);
  useDeviceChanges();
  const avail = availableIds(g);
  const shown = playingNow(g, players, bots.length, avail);
  const waiting = players.filter((p) => !avail.has(p.ctl));
  const total = shown.length + bots.length;
  const canAdd = total < 10;

  const looks = [...shown.map((p) => p.look), ...bots.map((b) => b.look)];
  const slotOf = placeLineup(looks);
  const defaults = schemeTeams(g, rules.scheme);
  const teamAt = (k: number) => teamFor(looks[k], slotOf[k], defaults);
  const setLook = (k: number, look: Look) => {
    if (k < shown.length) {
      const who = shown[k];
      setPlayers((ps) => ps.map((p) => (p === who ? { ...p, look } : p)));
    } else setBots((bs) => bs.map((b, i) => (i === k - shown.length ? { ...b, look } : b)));
  };
  const team = (k: number) => (rules.teamPlay ? teamAt(k) : undefined);
  const flipTeam = (k: number) => setLook(k, withTeam(looks[k], teamAt(k) ^ 1));

  const addPlayer = (j: Join) => {
    const swap = j.swap;
    // (somebody with that set already: a player waiting for that device, or a join just before not drawn yet)
    const taken = (ps: Human[]) => ps.some((p) => p.ctl !== swap?.from && idsClash(st.controls, p.ctl, j.id));
    if (!canAdd || taken(players)) return;
    setPlayers((ps) => (taken(ps) ? ps : [...(swap ? ps.map((p) => (p.ctl === swap.from ? { ...p, ctl: swap.to } : p)) : ps), { ctl: j.id, look: NO_LOOK }]));
    sound('ok');
    toast(`${findSet(st.controls, j.id)?.name ?? 'Player'} joined`);
  };
  useJoinListener(canAdd && picker === null && colorFor === null, shown.map((p) => p.ctl), addPlayer);

  const removePlayer = (who: Human) =>
    setPlayers((ps) => {
      const rest = ps.filter((p) => p !== who);
      // whoever shared the gamepad gets all of it
      const ids = mergeHalves(rest.map((p) => p.ctl), who.ctl);
      return rest.map((p, i) => (p.ctl === ids[i] ? p : { ...p, ctl: ids[i] }));
    });

  // the line-up is kept as it changes: for the next visit, the Rematch tile and the original menus' player setup
  const shownKey = shown.map((p) => p.ctl).join('|');
  useEffect(() => {
    storeLineup(g, players, bots);
    applyRules(st, rules);
    g.session.slots = lineupSlots(g, shown, bots, rules.scheme);
    g.session.fromLineup = false;
    save();
  }, [players, bots, rules, shownKey]);

  const start = () => {
    if (total < 2) {
      sound('no');
      return toast('Add at least one more player or a computer player', true);
    }
    const slots = lineupSlots(g, shown, bots, rules.scheme);
    if (rules.teamPlay && new Set(slots.filter((s) => s.type !== INPUT_OFF).map((s) => s.team)).size < 2) {
      sound('no');
      return toast('Both teams need at least one player', true);
    }
    g.session.slots = slots;
    exit({ kind: 'local' });
  };

  const names = [...shown.map((_, i) => `Player ${i + 1}`), ...bots.map(() => 'Computer')];

  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" onClick={back}>◀ Back</button>
        <h1>Local Game</h1>
        <button class="btn primary" data-autofocus="" onClick={start}>Start ▶</button>
      </div>
      <div class="body cols-2">
        <div class="panel scroll">
          <h2>Players <span class="hint">on this device</span></h2>
          {!!rules.teamPlay && (
            <TeamBalance
              white={Array.from({ length: total }, (_, k) => teamAt(k)).filter((t) => t === 0).length}
              red={Array.from({ length: total }, (_, k) => teamAt(k)).filter((t) => t === 1).length}
            />
          )}
          <div class="players">
            {shown.map((p, i) => (
              <PlayerCard
                slot={slotOf[i]}
                name={names[i]}
                set={findSet(st.controls, p.ctl)}
                team={team(i)}
                onTeam={() => flipTeam(i)}
                onColor={() => setColorFor(i)}
                onPickSet={() => setPicker(p)}
                onRemove={shown.length > 1 || bots.length ? () => removePlayer(p) : undefined}
              />
            ))}
            {canAdd && (
              <button class="pcard add" onClick={() => setPicker('add')}>
                ＋ Add player
              </button>
            )}
          </div>
          {canAdd && <div class="small muted">{joinHint(g)}</div>}
          {!!waiting.length && (
            <div class="small muted">
              Back with their device: {waiting.map((p) => setName(st.controls, p.ctl)).join(', ')}
            </div>
          )}
          <h2>Computer players</h2>
          <div class="players">
            {bots.map((b, j) => {
              const k = shown.length + j;
              return (
                <BotCard
                  slot={slotOf[k]}
                  skill={b.skill}
                  team={team(k)}
                  onTeam={() => flipTeam(k)}
                  onColor={() => setColorFor(k)}
                  onSkill={(v) => setBots((bs) => bs.map((x, i) => (i === j ? { ...x, skill: v } : x)))}
                  onRemove={() => setBots((bs) => bs.filter((_, i) => i !== j))}
                />
              );
            })}
            {total < 10 && (
              <button class="pcard add" onClick={() => setBots((bs) => [...bs, { skill: bs.length ? bs[bs.length - 1].skill : AI_DEFAULT, look: NO_LOOK }])}>
                ＋ Add computer player
              </button>
            )}
          </div>
        </div>
        <RulesPanel rules={rules} onChange={setRules} />
      </div>
      {picker !== null && (
        <ControlPicker
          current={picker === 'add' ? null : picker.ctl}
          used={shown.map((p) => p.ctl)}
          onClose={() => setPicker(null)}
          onPick={(id) => {
            if (picker === 'add') addPlayer({ id });
            else setPlayers((ps) => ps.map((p) => (p === picker ? { ...p, ctl: id } : p)));
            setPicker(null);
          }}
        />
      )}
      {colorFor !== null && (
        <ColorPicker
          current={slotOf[colorFor]}
          takenBy={Array.from({ length: 10 }, (_, c) => {
            // people keep their colours; computer players make room
            const k = slotOf.indexOf(c);
            return k >= 0 && k !== colorFor && k < shown.length ? names[k] : null;
          })}
          onClose={() => setColorFor(null)}
          onPick={(c) => {
            setLook(colorFor, withColor(looks[colorFor], c));
            setColorFor(null);
          }}
        />
      )}
    </div>
  );
}
