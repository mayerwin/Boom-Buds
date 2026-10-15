// Local Game: up to four players on this device (keyboard sets, gamepads, mouse, touch) plus computer
// players, each with a colour and a team they can change, the arena and the rules.

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { RulesPanel, applyRules, rulesFromSettings, type Rules } from './rules.tsx';
import { BotCard, ColorPicker, ControlPicker, PlayerCard, TeamBalance, useJoinListener } from './players.tsx';
import { NO_LOOK, placeLineup, schemeTeams, teamFor, withColor, withTeam } from './lineup.ts';
import { availableSets, findSet, isTouchOnly, isTvApp, TV_REMOTE } from '../app/controls.ts';
import { AI_DEFAULT, INPUT_AI, INPUT_KEY, INPUT_OFF, type Slot } from '../app/session.ts';
import type { Look } from '../app/settings.ts';
import type { Game } from '../app/Game.ts';

const MAX_HUMANS = 4;

export interface Human {
  ctl: string;
  look: Look;
}

export interface Bot {
  skill: number;
  look: Look;
}

/** The previous line-up, keeping only the players whose control sets exist on this device now. */
export function initialLineup(g: Game): { players: Human[]; bots: Bot[] } {
  const st = g.settings;
  const sets = availableSets(st.controls, g.app.input, g.app.isTouch);
  const avail = new Set(sets.map((s) => s.id));
  let players: Human[] = st.localPlayers
    .map((ctl, i) => ({ ctl, look: st.localLooks.players[i] ?? NO_LOOK }))
    .filter((p) => avail.has(p.ctl))
    .slice(0, MAX_HUMANS);
  // first time: on a TV a gamepad, else the remote; touch controls on a phone; the arrow keys otherwise
  const pads = sets.filter((s) => s.kind === 'pad');
  const tvPad = isTvApp() ? (pads.find((s) => s.name !== TV_REMOTE) ?? pads[0])?.id : undefined;
  if (!players.length) players = [{ ctl: tvPad ?? (g.app.isTouch || isTouchOnly() ? 'touch' : 'kb-arrows'), look: NO_LOOK }];
  const bots = st.localBots.slice(0, 10 - players.length).map((skill, k) => ({ skill, look: st.localLooks.bots[k] ?? NO_LOOK }));
  return { players, bots };
}

/** The control sets of the previous line-up (network games bring this machine's players). */
export function initialPlayers(g: Game): string[] {
  return initialLineup(g).players.map((p) => p.ctl);
}

/** The ten slots of a line-up: everybody in the slot of their colour, with their team. */
export function lineupSlots(g: Game, players: Human[], bots: Bot[], scheme: string): Slot[] {
  const looks = [...players.map((p) => p.look), ...bots.map((b) => b.look)];
  const slotOf = placeLineup(looks);
  const teams = schemeTeams(g, scheme);
  const slots: Slot[] = Array.from({ length: 10 }, (_, i) => ({ type: INPUT_OFF, dev: 0, team: teams[i], owner: 0, ai: AI_DEFAULT }));
  looks.forEach((look, k) => {
    const i = slotOf[k];
    if (i < 0) return;
    const team = teamFor(look, i, teams);
    if (k < players.length) slots[i] = { ...slots[i], type: INPUT_KEY, ctl: players[k].ctl, team, name: `P${k + 1}` };
    else slots[i] = { ...slots[i], type: INPUT_AI, ai: bots[k - players.length].skill, team, name: 'CPU' };
  });
  return slots;
}

/**
 * The last Local Game line-up, if it can be played again right away (its control sets are still there and
 * it has at least two players): a short description, after filling session.slots when `apply`.
 */
export function quickMatchSlots(g: Game, apply: boolean): string {
  const st = g.settings;
  if (!st.localPlayers.length) return '';
  const avail = new Set(availableSets(st.controls, g.app.input, g.app.isTouch).map((x) => x.id));
  if (!st.localPlayers.every((id) => avail.has(id))) return '';
  const { players, bots } = initialLineup(g);
  if (players.length + bots.length < 2) return '';
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
  const [picker, setPicker] = useState<number | null>(null);
  /** colour being chosen: index in players, then bots */
  const [colorFor, setColorFor] = useState<number | null>(null);
  const total = players.length + bots.length;
  const canAddHuman = players.length < MAX_HUMANS && total < 10;

  const looks = [...players.map((p) => p.look), ...bots.map((b) => b.look)];
  const slotOf = placeLineup(looks);
  const defaults = schemeTeams(g, rules.scheme);
  const teamAt = (k: number) => teamFor(looks[k], slotOf[k], defaults);
  const setLook = (k: number, look: Look) => {
    if (k < players.length) setPlayers((ps) => ps.map((p, i) => (i === k ? { ...p, look } : p)));
    else setBots((bs) => bs.map((b, i) => (i === k - players.length ? { ...b, look } : b)));
  };
  const team = (k: number) => (rules.teamPlay ? teamAt(k) : undefined);
  const flipTeam = (k: number) => setLook(k, withTeam(looks[k], teamAt(k) ^ 1));

  const addPlayer = (id: string) => {
    if (!canAddHuman) return;
    setPlayers((p) => [...p, { ctl: id, look: NO_LOOK }]);
    sound('ok');
    toast(`${findSet(st.controls, id)?.name ?? 'Player'} joined`);
  };
  useJoinListener(canAddHuman && picker === null && colorFor === null, players.map((p) => p.ctl), addPlayer);

  const persist = () => {
    st.localPlayers = players.map((p) => p.ctl);
    st.localBots = bots.map((b) => b.skill);
    st.localLooks = { players: players.map((p) => p.look), bots: bots.map((b) => b.look) };
    applyRules(st, rules);
    save();
  };

  const start = () => {
    if (total < 2) {
      sound('no');
      return toast('Add at least one more player or a computer player', true);
    }
    const slots = lineupSlots(g, players, bots, rules.scheme);
    if (rules.teamPlay && new Set(slots.filter((s) => s.type !== INPUT_OFF).map((s) => s.team)).size < 2) {
      sound('no');
      return toast('Both teams need at least one player', true);
    }
    persist();
    g.session.slots = slots;
    exit({ kind: 'local' });
  };

  const names = [...players.map((_, i) => `Player ${i + 1}`), ...bots.map(() => 'Computer')];

  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" onClick={() => { persist(); back(); }}>◀ Back</button>
        <h1>Local Game</h1>
        <button class="btn primary" data-autofocus="" onClick={start}>Start ▶</button>
      </div>
      <div class="body cols-2">
        <div class="panel scroll">
          <h2>Players <span class="hint">up to {MAX_HUMANS} on this device</span></h2>
          {!!rules.teamPlay && (
            <TeamBalance
              white={Array.from({ length: total }, (_, k) => teamAt(k)).filter((t) => t === 0).length}
              red={Array.from({ length: total }, (_, k) => teamAt(k)).filter((t) => t === 1).length}
            />
          )}
          <div class="players">
            {players.map((p, i) => (
              <PlayerCard
                slot={slotOf[i]}
                name={names[i]}
                set={findSet(st.controls, p.ctl)}
                team={team(i)}
                onTeam={() => flipTeam(i)}
                onColor={() => setColorFor(i)}
                onPickSet={() => setPicker(i)}
                onRemove={players.length > 1 || bots.length ? () => setPlayers((ps) => ps.filter((_, k) => k !== i)) : undefined}
              />
            ))}
            {canAddHuman && (
              <button class="pcard add" onClick={() => setPicker(-1)}>
                ＋ Add player
              </button>
            )}
          </div>
          {canAddHuman && (
            <div class="small muted">
              {g.app.isTouch && !g.app.input.keyboardSeen
                ? 'Two players can share this screen: choose “Touch, left side” and “Touch, right side”.'
                : 'Or just press a bomb key (like A or the period key) or a gamepad button to join.'}
            </div>
          )}
          <h2>Computer players</h2>
          <div class="players">
            {bots.map((b, j) => {
              const k = players.length + j;
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
          current={picker >= 0 ? players[picker].ctl : null}
          used={players.map((p) => p.ctl)}
          onClose={() => setPicker(null)}
          onPick={(id) => {
            if (picker >= 0) setPlayers((ps) => ps.map((p, k) => (k === picker ? { ...p, ctl: id } : p)));
            else addPlayer(id);
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
            return k >= 0 && k !== colorFor && k < players.length ? names[k] : null;
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
