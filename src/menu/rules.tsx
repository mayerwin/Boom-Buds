// Match rules: the arena, wins needed, round time, scheme and the original's other options. Shared by the
// Local Game screen and the network lobby (where only the host changes them; the others' changes are
// requests to the host, shown in the chat and marked "asked" here until the host decides).

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { Modal, Stepper, Toggle, Picker, changing } from './ui.tsx';
import { ARENA_COUNT } from './art.ts';
import { cleanLevels, type Settings } from '../app/settings.ts';
import type { Game } from '../app/Game.ts';
import { allSchemes, loadCustomSchemes } from '../app/schemes.ts';
import { specialLevels } from '../game/levels.ts';

export interface Rules {
  /** an arena 0-10, or random: -1 any, -2 one with something special, -3 one of `levels` */
  level: number;
  /** the arenas of the list a random arena is picked from (level -3), and its name ('' if not saved) */
  levels: number[];
  listName: string;
  wins: number;
  scheme: string;
  playtime: number;
  enclosement: number;
  conveyor: number;
  randomStart: number;
  stomped: number;
  diseases: number;
  teamPlay: number;
  winByKills: number;
  goldman: number;
}

export function rulesFromSettings(st: Settings): Rules {
  return {
    level: st.levelno,
    levels: [...st.levelList],
    listName: st.levelListName,
    wins: st.num_to_win_match,
    scheme: st.schemefilename,
    playtime: st.playtime,
    enclosement: st.enclosement_depth,
    conveyor: st.conveyor_speed,
    randomStart: st.random_start,
    stomped: st.stomped_bombs_detonate,
    diseases: st.diseases_destroyable,
    teamPlay: st.team_play,
    winByKills: st.team_play ? 0 : st.win_by_kills,
    goldman: st.goldman,
  };
}

export function applyRules(st: Settings, r: Rules): void {
  st.levelList = cleanLevels(r.levels);
  st.levelListName = r.listName ?? '';
  st.levelno = r.level === -3 && !st.levelList.length ? -1 : r.level;
  st.num_to_win_match = r.wins;
  st.schemefilename = r.scheme;
  st.playtime = r.playtime;
  st.enclosement_depth = r.enclosement;
  st.conveyor_speed = r.conveyor;
  st.random_start = r.randomStart;
  st.stomped_bombs_detonate = r.stomped;
  st.diseases_destroyable = r.diseases;
  st.team_play = r.teamPlay;
  st.win_by_kills = r.teamPlay ? 0 : r.winByKills;
  st.goldman = r.goldman;
}

const PLAYTIMES = [60, 90, 120, 150, 180, 240, 300, 600, 1001];
const WALLS = ['None', 'A little', 'A lot', 'All the way'];
const CONVEYOR = ['Slow', 'Medium', 'Fast'];
const timeLabel = (t: number) => (t === 1001 ? 'Unlimited' : `${Math.trunc(t / 60)}:${String(t % 60).padStart(2, '0')}`);

/** Display name of a scheme ("Air Chaos! (10)" -> "Air Chaos!", with the player limit apart). */
export function schemeLabel(name: string): { title: string; max: string } {
  const m = /^(.*?)\s*\((\d+)( ONLY)?\)\s*$/i.exec(name);
  return m ? { title: m[1], max: m[2] } : { title: name, max: '' };
}

function arenaTitle(g: Game, n: number): string {
  return g.app.text.messages[150 + n] ?? `Arena ${n + 1}`;
}

/** The arena choice in words ("The Coal Mine", "Random special arena", "Random from Party (4 arenas)"). */
export function arenaName(g: Game, r: Pick<Rules, 'level' | 'levels' | 'listName'>): string {
  if (r.level >= 0) return arenaTitle(g, r.level);
  if (r.level === -2) return 'Random special arena';
  if (r.level === -3) return `Random from ${r.listName || 'your pick'} (${r.levels.length} arena${r.levels.length === 1 ? '' : 's'})`;
  return 'Random arena';
}

/** What is special about an arena ("conveyor belts", "ice"...), from the game's data. */
export function arenaFeatures(g: Game, n: number): string[] {
  const v = (id: number) => g.app.text.values[id]?.[0] ?? 0;
  const kinds = new Set((g.app.text.extras[String(n)] ?? []).map((e) => e.kind));
  const out: string[] = [];
  if (v(450 + n) > 0) out.push('ice');
  if (v(340 + n) > 0) out.push('bricks grow back');
  if (kinds.has('A')) out.push('arrows');
  if (kinds.has('W')) out.push('warp holes');
  if (kinds.has('C')) out.push('conveyor belts');
  if (kinds.has('T')) out.push('trampolines');
  return out;
}

/** How a change of the rules reads ("Round time 3:00 · Teams on"); `rules` already include the change. */
export function describeRules(g: Game, rules: Rules, patch: Partial<Rules>): string {
  const onOff = (v: number) => (v ? 'on' : 'off');
  const parts: string[] = [];
  const keys = Object.keys(patch) as (keyof Rules)[];
  if (keys.some((k) => k === 'level' || k === 'levels' || k === 'listName')) parts.push(`Arena: ${arenaName(g, rules)}`);
  for (const k of keys) {
    if (k === 'wins') parts.push(`${rules.winByKills ? 'Kills to win' : 'Wins to take the match'} ${rules.wins}`);
    else if (k === 'playtime') parts.push(`Round time ${timeLabel(rules.playtime)}`);
    else if (k === 'scheme') parts.push(`Scheme ${schemeLabel(allSchemes(g.app).find((s) => s.file.toUpperCase() === rules.scheme.toUpperCase())?.name ?? rules.scheme).title}`);
    else if (k === 'teamPlay') parts.push(`Teams ${onOff(rules.teamPlay)}`);
    else if (k === 'enclosement') parts.push(`Closing walls ${WALLS[rules.enclosement] ?? rules.enclosement}`);
    else if (k === 'conveyor') parts.push(`Conveyor speed ${CONVEYOR[rules.conveyor] ?? rules.conveyor}`);
    else if (k === 'randomStart') parts.push(`Random start positions ${onOff(rules.randomStart)}`);
    else if (k === 'stomped') parts.push(`Stomped bombs explode ${onOff(rules.stomped)}`);
    else if (k === 'diseases') parts.push(`Diseases can be destroyed ${onOff(rules.diseases)}`);
    else if (k === 'winByKills' && !keys.includes('teamPlay')) parts.push(`Win the match by kills ${onOff(rules.winByKills)}`);
    else if (k === 'goldman') parts.push(`Gold Bud bonus game ${onOff(rules.goldman)}`);
  }
  return parts.join(' · ');
}

type ArenaChoice = Pick<Rules, 'level' | 'levels' | 'listName'>;

/** The stops of the arena picker: random, random special, the saved lists, the player's own pick, each arena. */
function arenaStops(g: Game): ({ kind: 'random' | 'special' | 'arena'; level: number } | { kind: 'list'; name: string; levels: number[] } | { kind: 'pick' })[] {
  return [
    { kind: 'random', level: -1 },
    { kind: 'special', level: -2 },
    ...g.settings.arenaLists.map((l) => ({ kind: 'list' as const, name: l.name, levels: l.levels })),
    { kind: 'pick' },
    ...Array.from({ length: ARENA_COUNT }, (_, n) => ({ kind: 'arena' as const, level: n })),
  ];
}

function stopIndex(g: Game, r: ArenaChoice): number {
  const stops = arenaStops(g);
  if (r.level >= 0) return stops.findIndex((s) => s.kind === 'arena' && s.level === r.level);
  if (r.level === -2) return 1;
  if (r.level === -3) {
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const saved = stops.findIndex((s) => s.kind === 'list' && s.name === r.listName && same(s.levels, cleanLevels(r.levels)));
    return saved >= 0 ? saved : stops.findIndex((s) => s.kind === 'pick');
  }
  return 0;
}

/** Up to four arena pictures in a square (an arena list). */
function Mosaic(props: { levels: number[] }): JSX.Element {
  const { art } = useMenu();
  const [pics, setPics] = useState<string[]>([]);
  const shown = props.levels.slice(0, 4);
  useEffect(() => {
    let live = true;
    void Promise.all(shown.map((n) => art.arena(n))).then((p) => live && setPics(p));
    return () => {
      live = false;
    };
  }, [shown.join(',')]);
  return (
    <div class={`mosaic n${shown.length}`}>
      {shown.map((_, i) => <span style={{ backgroundImage: pics[i] ? `url(${pics[i]})` : undefined }} />)}
    </div>
  );
}

/**
 * The arena: ◀ ▶ (or Left / Right) go through a random arena, a random special arena, the saved lists, the
 * player's own pick (choosing it the first time opens the list of arenas to tick) and every arena.
 */
export function ArenaPicker(props: { rules: ArenaChoice; onChange?: (c: ArenaChoice) => void; asked?: boolean }): JSX.Element {
  const { g, art } = useMenu();
  const [pic, setPic] = useState('');
  const [picking, setPicking] = useState(false);
  const { rules, onChange } = props;
  const level = rules.level;
  useEffect(() => {
    let live = true;
    setPic('');
    if (level >= 0) void art.arena(level).then((u) => live && setPic(u));
    return () => {
      live = false;
    };
  }, [level]);
  // the other arenas load in the background
  useEffect(() => {
    for (let l = 0; l < ARENA_COUNT; l++) void art.arena(l);
  }, []);
  const stops = arenaStops(g);
  const at = Math.max(0, stopIndex(g, rules));
  const go = (d: number) => {
    if (!onChange) return;
    const s = stops[(at + d + stops.length) % stops.length];
    if (s.kind === 'list') onChange({ level: -3, levels: s.levels, listName: s.name });
    else if (s.kind === 'pick') {
      // the player's own pick: the last one again, or the arenas to tick
      if (rules.levels.length && !rules.listName) onChange({ level: -3, levels: rules.levels, listName: '' });
      else setPicking(true);
    } else onChange({ level: s.level, levels: rules.levels, listName: rules.listName });
  };
  const stop = stops[at];
  const ownPick = stop.kind === 'pick';
  const name = arenaName(g, rules);
  const special = level === -2 ? specialLevels(g.app.text.values, g.app.text.extras) : [];
  return (
    <div
      class={`arena ${props.asked ? 'asked' : ''}`}
      tabIndex={onChange ? 0 : -1}
      data-edit={onChange ? '' : undefined}
      aria-label={`arena: ${name}`}
      onKeyDown={(e) => {
        // (Left / Right go through the arenas once Enter started changing the choice: src/menu/nav.ts)
        if (!onChange || e.target !== e.currentTarget || !changing(e)) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      }}
    >
      {onChange ? <button class="btn icon" tabIndex={-1} onClick={() => go(-1)} aria-label="previous arena">◀</button> : <span />}
      {level >= 0 ? (
        <div class="pic" style={{ backgroundImage: pic ? `url(${pic})` : undefined }}>
          <div class="name">{name}{props.asked && <span class="asked-tag">asked</span>}</div>
        </div>
      ) : level === -3 ? (
        <div class="pic list">
          <Mosaic levels={rules.levels} />
          {onChange && (
            // (a control of its own: the arrows reach it, Enter opens the list of arenas)
            <button class="btn small edit" onClick={() => setPicking(true)}>
              {ownPick ? '✎ Change' : '✎ Edit'}
            </button>
          )}
          <div class="name">{name}{props.asked && <span class="asked-tag">asked</span>}</div>
        </div>
      ) : (
        <div class="pic random">
          {level === -2 ? '✨' : '🎲'}
          <div class="name">
            {name}
            {props.asked && <span class="asked-tag">asked</span>}
            {level === -2 && <div class="sub">{special.map((n) => arenaTitle(g, n)).join(' · ')}</div>}
          </div>
        </div>
      )}
      {onChange ? <button class="btn icon" tabIndex={-1} onClick={() => go(1)} aria-label="next arena">▶</button> : <span />}
      {picking && (
        <ArenaListPicker
          initial={level === -3 ? rules : { levels: rules.levels.length ? rules.levels : level >= 0 ? [level] : specialLevels(g.app.text.values, g.app.text.extras), listName: '' }}
          onClose={() => setPicking(false)}
          onPick={(levels, listName) => {
            setPicking(false);
            onChange?.({ level: -3, levels, listName });
          }}
        />
      )}
    </div>
  );
}

/**
 * Tick the arenas to play (a match picks one at random for each round); a name saves the list with the
 * options, so that it comes back among the arena picker's choices.
 */
export function ArenaListPicker(props: {
  initial: Pick<Rules, 'levels' | 'listName'>;
  onPick: (levels: number[], name: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { g, art, save, toast } = useMenu();
  const [on, setOn] = useState<Set<number>>(() => new Set(cleanLevels(props.initial.levels)));
  const [name, setName] = useState(props.initial.listName);
  const [pics, setPics] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(Array.from({ length: ARENA_COUNT }, (_, n) => art.arena(n))).then((p) => live && setPics(p));
    return () => {
      live = false;
    };
  }, []);
  const flip = (n: number) =>
    setOn((s) => {
      const t = new Set(s);
      if (t.has(n)) t.delete(n);
      else t.add(n);
      return t;
    });
  const special = specialLevels(g.app.text.values, g.app.text.extras);
  const saved = g.settings.arenaLists.find((l) => l.name === props.initial.listName);
  const done = () => {
    const levels = [...on].sort((a, b) => a - b);
    if (!levels.length) return toast('Tick at least one arena', true);
    const n = name.trim().slice(0, 24);
    if (n) {
      // a name saves the list (the same name replaces it)
      const lists = g.settings.arenaLists.filter((l) => l.name !== n && l.name !== props.initial.listName);
      g.settings.arenaLists = [...lists, { name: n, levels }];
      save();
      toast(`"${n}" saved`);
    }
    props.onPick(levels, n);
  };
  return (
    <Modal title="Pick the arenas" onClose={props.onClose} wide>
      <div class="small muted">Each round is played on one of the ticked arenas, at random.</div>
      <div class="row">
        <button class="btn small" onClick={() => setOn(new Set(Array.from({ length: ARENA_COUNT }, (_, n) => n)))}>All</button>
        <button class="btn small" onClick={() => setOn(new Set(special))}>Special ones</button>
        <button class="btn small" onClick={() => setOn(new Set())}>None</button>
      </div>
      <div class="arena-grid">
        {Array.from({ length: ARENA_COUNT }, (_, n) => {
          const feats = arenaFeatures(g, n);
          return (
            <button class={`arena-tick ${on.has(n) ? 'on' : ''}`} role="checkbox" aria-checked={on.has(n)} aria-label={arenaTitle(g, n)} onClick={() => flip(n)}>
              <span class="thumb" style={{ backgroundImage: pics[n] ? `url(${pics[n]})` : undefined }}>
                <span class="tick">{on.has(n) ? '✓' : ''}</span>
              </span>
              <b>{arenaTitle(g, n)}</b>
              <small>{feats.length ? feats.join(', ') : 'classic'}</small>
            </button>
          );
        })}
      </div>
      <div class="row">
        <input class="textin grow" value={name} maxLength={24} placeholder="Name (optional: saves the list)" aria-label="name of the list" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        {saved && (
          <button
            class="btn small ghost danger"
            onClick={() => {
              g.settings.arenaLists = g.settings.arenaLists.filter((l) => l !== saved);
              save();
              toast(`"${saved.name}" deleted`);
              setName('');
            }}
          >
            🗑 Delete "{saved.name}"
          </button>
        )}
        <button class="btn primary" data-autofocus="" onClick={done}>
          {name.trim() ? 'Save and play these' : 'Play these'} ({on.size})
        </button>
      </div>
    </Modal>
  );
}

/**
 * Arena and rules; `onChange` absent = read-only. `asked`: changes this player asked the host for (network
 * clients), shown instead of the host's values and marked until the host decides.
 */
export function RulesPanel(props: { rules: Rules; onChange?: (r: Rules) => void; maxPlayers?: number; asked?: Partial<Rules>; note?: string }): JSX.Element {
  const { g } = useMenu();
  const { onChange } = props;
  const asked = props.asked ?? {};
  const rules: Rules = { ...props.rules, ...asked };
  const is = (...keys: (keyof Rules)[]) => keys.some((k) => asked[k] !== undefined && JSON.stringify(asked[k]) !== JSON.stringify(props.rules[k]));
  const [pickScheme, setPickScheme] = useState(false);
  const set = (patch: Partial<Rules>) => onChange?.({ ...rules, ...patch });
  const schemes = allSchemes(g.app);
  const scheme = schemes.find((s) => s.file.toUpperCase() === rules.scheme.toUpperCase());
  const sl = schemeLabel(scheme?.name ?? rules.scheme);
  const ro = !onChange;
  const tag = (...keys: (keyof Rules)[]) => is(...keys) && <span class="asked-tag">asked</span>;
  return (
    <div class="panel scroll">
      <h2>Arena &amp; rules {props.note ? <span class="hint">{props.note}</span> : ro && <span class="hint">set by the host</span>}</h2>
      <ArenaPicker rules={rules} asked={is('level', 'levels', 'listName')} onChange={onChange ? (c) => set(c) : undefined} />
      <Stepper
        label={rules.winByKills ? 'Kills to win' : 'Wins to take the match'}
        value={rules.wins}
        asked={is('wins')}
        options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20].map((n) => ({ value: n, label: String(n) }))}
        onChange={onChange ? (v) => set({ wins: v }) : undefined}
      />
      <Stepper label="Round time" value={rules.playtime} asked={is('playtime')} options={PLAYTIMES.map((t) => ({ value: t, label: timeLabel(t) }))} onChange={onChange ? (v) => set({ playtime: v }) : undefined} />
      <div class={`setting ${is('scheme') ? 'asked' : ''}`}>
        <label>Scheme {sl.max && <span class="small">· up to {sl.max} players</span>}{tag('scheme')}</label>
        <button class="btn small" disabled={ro} onClick={() => setPickScheme(true)}>{sl.title}</button>
      </div>
      <Toggle label="Teams (white against red)" value={!!rules.teamPlay} asked={is('teamPlay')} onChange={onChange ? (v) => set({ teamPlay: v ? 1 : 0, winByKills: v ? 0 : rules.winByKills }) : undefined} />
      <details class="more">
        <summary tabIndex={0}>More rules</summary>
        <Stepper label="Closing walls (hurry)" value={rules.enclosement} asked={is('enclosement')} options={WALLS.map((l, i) => ({ value: i, label: l }))} onChange={onChange ? (v) => set({ enclosement: v }) : undefined} />
        <Stepper label="Conveyor speed" value={rules.conveyor} asked={is('conveyor')} options={CONVEYOR.map((l, i) => ({ value: i, label: l }))} onChange={onChange ? (v) => set({ conveyor: v }) : undefined} />
        <Toggle label="Random start positions" value={!!rules.randomStart} asked={is('randomStart')} onChange={onChange ? (v) => set({ randomStart: v ? 1 : 0 }) : undefined} />
        <Toggle label="Stomped bombs explode" value={!!rules.stomped} asked={is('stomped')} onChange={onChange ? (v) => set({ stomped: v ? 1 : 0 }) : undefined} />
        <Toggle label="Diseases can be destroyed" value={!!rules.diseases} asked={is('diseases')} onChange={onChange ? (v) => set({ diseases: v ? 1 : 0 }) : undefined} />
        <Toggle label="Win the match by kills" disabled={!!rules.teamPlay} value={!!rules.winByKills} asked={is('winByKills')} onChange={onChange ? (v) => set({ winByKills: v ? 1 : 0 }) : undefined} />
        <Toggle label="Gold Bud bonus game" hint="the match winner spins the wheel for a power-up" value={!!rules.goldman} asked={is('goldman')} onChange={onChange ? (v) => set({ goldman: v ? 1 : 0 }) : undefined} />
      </details>
      {pickScheme && (
        <Picker
          title="Scheme"
          current={rules.scheme.toUpperCase()}
          items={(() => {
            // schemes made with the editor (or imported) first, marked with a star
            const mine = loadCustomSchemes();
            const items = schemes.map((s) => {
              const l = schemeLabel(s.name);
              const own = mine[s.file.toUpperCase()] !== undefined;
              return { value: s.file.toUpperCase(), label: own ? `★ ${l.title}` : l.title, sub: l.max ? `${l.max} players` : '', own };
            });
            return [...items.filter((i) => i.own), ...items.filter((i) => !i.own)];
          })()}
          onPick={(v) => {
            set({ scheme: v });
            setPickScheme(false);
          }}
          onClose={() => setPickScheme(false)}
        />
      )}
    </div>
  );
}
