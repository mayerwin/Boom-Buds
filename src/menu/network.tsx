// Network Game: games on this network appear by themselves; create a game, or join one with its room code
// (or a link). Then the lobby: every machine brings its own players, the host picks the rules and starts.

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { CodeInput, Modal } from './ui.tsx';
import { NetSession, type JoinOutcome } from '../net/netSession.ts';
import { normalizeRoomCode } from '../net/room.ts';
import { LanScanner, lanKeys, type LanGame } from '../net/lan.ts';
import { BotCard, ColorPicker, ControlPicker, PlayerCard, TeamBalance, useJoinListener } from './players.tsx';
import { withColor, withTeam } from './lineup.ts';
import { RulesPanel, type Rules } from './rules.tsx';
import { LobbyChat } from './chat.tsx';
import { findSet } from '../app/controls.ts';
import { AI_DEFAULT, INPUT_AI, INPUT_KEY, INPUT_OFF } from '../app/session.ts';
import type { Game } from '../app/Game.ts';
import type { LobbyChange, LobbyModel } from './lobbyModel.ts';

const REASONS: Record<Exclude<JoinOutcome, 'ok'>, string> = {
  'not-found': 'No game with this code (check it, or ask the host to keep the lobby open)',
  full: 'This game is full',
  started: 'This game is already playing; try again when the match is over',
  version: 'This game runs another version of Boom Buds: both should reload the page',
  kicked: 'The host removed you from this game',
  failed: 'Could not connect to that game (network blocked?)',
};

export function defaultName(g: Game): string {
  if (!g.settings.nodename) {
    const n = Math.max(g.ui.value(47), 1);
    g.settings.nodename = g.app.text.messages[500 + (g.ui.rand() % n)] ?? 'Bud';
    g.app.saveSettings();
  }
  return g.settings.nodename;
}

/** The room code in a link (?join=CODE), once. */
export function hasJoinLink(): boolean {
  return !!linkCode;
}

let linkCode: string | null = (() => {
  try {
    return normalizeRoomCode(new URLSearchParams(location.search).get('join') ?? '');
  } catch {
    return null;
  }
})();

export function NetworkGame(props: { enterLobby: (net: NetSession) => void }): JSX.Element {
  const { g, back, toast, net, setNet, sound, art } = useMenu();
  const [name, setName] = useState(() => defaultName(g));
  const [status, setStatus] = useState<'connecting' | 'ready' | 'offline'>(net ? 'ready' : 'connecting');
  const [games, setGames] = useState<LanGame[]>([]);
  const [busy, setBusy] = useState('');
  const [pics, setPics] = useState<Record<number, string>>({});
  const netRef = useRef(net);
  netRef.current = net;
  // the session being opened: Create and Join can be pressed before the meeting service answers
  const opening = useRef<Promise<NetSession | null>>(Promise.resolve(net));

  useEffect(() => {
    let live = true;
    let scanner: LanScanner | null = null;
    const ready = async (n: NetSession) => {
      const keys = await lanKeys(n.relay);
      if (!live || !keys.length) return;
      scanner = new LanScanner(n.relay, keys);
      scanner.onChange = () => setGames(scanner!.list());
    };
    if (net) void ready(net);
    else {
      opening.current = NetSession.connect(name).then(
        (n) => {
          if (!live) {
            n.close();
            return null;
          }
          netRef.current = n;
          setNet(n);
          setStatus('ready');
          void ready(n);
          if (linkCode) {
            const c = linkCode;
            linkCode = null;
            void join(c);
          }
          return n;
        },
        () => {
          if (live) setStatus('offline');
          return null;
        },
      );
    }
    return () => {
      live = false;
      scanner?.stop();
    };
  }, [status === 'offline']);

  useEffect(() => {
    for (const gm of games) if (gm.level >= 0 && !pics[gm.level]) void art.arena(gm.level).then((u) => setPics((p) => ({ ...p, [gm.level]: u })));
  }, [games]);

  const rename = (v: string) => {
    const clean = v.replace(/\s+/g, ' ').slice(0, 20);
    setName(clean);
    g.settings.nodename = clean.trim() || g.settings.nodename;
    g.app.saveSettings();
  };

  /** The session, once the meeting service answered (null if it cannot be reached). */
  const session = async (): Promise<NetSession | null> => netRef.current ?? (await opening.current);

  const create = async () => {
    if (busy) return;
    setBusy('create');
    try {
      const n = await session();
      if (!n) return;
      n.setName(name.trim() || 'Bud');
      await n.create();
      sound('ok');
      props.enterLobby(n);
    } catch {
      toast('Could not create the game', true);
    } finally {
      setBusy('');
    }
  };

  const join = async (code: string) => {
    const c = normalizeRoomCode(code);
    if (!c) return toast('A room code has 6 letters and digits', true);
    if (busy) return;
    setBusy(`join ${c}`);
    const n = await session();
    if (!n) return setBusy('');
    n.setName(name.trim() || 'Bud');
    const r = await n.join(c);
    setBusy('');
    if (r === 'ok') {
      sound('ok');
      props.enterLobby(n);
    } else {
      sound('no');
      toast(REASONS[r], true);
    }
  };

  const leave = () => {
    netRef.current?.close();
    setNet(null);
    back();
  };

  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" onClick={leave}>◀ Back</button>
        <h1>Network Game</h1>
        <span style={{ width: 'calc(var(--tap) * 2)' }} />
      </div>
      <div class="body cols-2">
        <div class="panel scroll">
          <h2>
            Games on your network
            {status === 'ready' && <span class="pulse" title="looking for games" />}
          </h2>
          {status === 'offline' ? (
            <div class="empty">
              <span>Cannot reach the meeting service. Are you online?</span>
              <button class="btn small" onClick={() => setStatus('connecting')}>Retry</button>
            </div>
          ) : status === 'connecting' ? (
            <div class="empty">Connecting…</div>
          ) : games.length === 0 ? (
            <div class="empty">No game yet. Games created on computers and phones of this network show up here by themselves.</div>
          ) : (
            <div class="gamelist">
              {games.map((gm) => (
                <div class="game-item">
                  <div class="thumb" style={{ backgroundImage: gm.level >= 0 && pics[gm.level] ? `url(${pics[gm.level]})` : undefined }}>{gm.level < 0 ? '🎲' : ''}</div>
                  <div class="grow">
                    <b>{gm.host}</b>
                    <div class="small muted">
                      {gm.players} player{gm.players === 1 ? '' : 's'} · {gm.level < 0 ? 'random arena' : g.app.text.messages[150 + gm.level]}
                    </div>
                  </div>
                  <button class="btn primary small" disabled={!!busy} onClick={() => void join(gm.code)}>
                    {busy === `join ${gm.code}` ? 'Joining…' : 'Join'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div class="panel scroll">
          <h2>Your name</h2>
          <input class="textin" value={name} maxLength={20} onInput={(e) => rename((e.target as HTMLInputElement).value)} aria-label="your name" />
          <h2>Start a game</h2>
          <button class="btn primary" data-autofocus="" disabled={status === 'offline' || !!busy} onClick={() => void create()}>
            {busy === 'create' ? 'Creating…' : 'Create a game'}
          </button>
          <div class="small muted">Players on this network see it in their list; friends elsewhere join with its code.</div>
          <h2>Join with a code</h2>
          <CodeInput onSubmit={(c) => void join(c)} />
          <div class="status">{busy.startsWith('join') ? 'Joining…' : ''}</div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------- lobby

export function Lobby(props: { model: LobbyModel; onLeave: () => void }): JSX.Element {
  const { g, toast, exit, sound } = useMenu();
  const { model } = props;
  const net = model.net;
  const [, redraw] = useState(0);
  const [picker, setPicker] = useState<number | null>(null);
  const [colorFor, setColorFor] = useState<{ ctl?: string; bot?: number; slot: number } | null>(null);
  /** not the host: the changes this player asked for, until the host decides */
  const [asked, setAsked] = useState<Partial<Rules>>({});
  const [kickFor, setKickFor] = useState<number | null>(null);
  useEffect(() => {
    model.onChange = () => redraw((x) => x + 1);
    model.onStart = (params) => exit({ kind: 'net-match', params });
    const host = net.memberName(net.hostId);
    const t = setInterval(() => {
      if (net.hostLost || net.kicked) {
        clearInterval(t);
        toast(net.kicked ? `${host} removed you from the game` : 'The host closed the game', true);
        props.onLeave();
      } else redraw((x) => x + 1); // pings
    }, 1000);
    return () => {
      clearInterval(t);
      model.onChange = () => {};
    };
  }, []);

  const view = model.view;
  // a request is settled once the host changes that setting (to what was asked, or to something else)
  const lastRules = useRef(view.rules);
  useEffect(() => {
    const before = lastRules.current;
    lastRules.current = view.rules;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    setAsked((a) => {
      const keep: Partial<Rules> = {};
      for (const k of Object.keys(a) as (keyof Rules)[]) if (same(before[k], view.rules[k]) && !same(a[k], view.rules[k])) (keep as Record<string, unknown>)[k] = a[k];
      return Object.keys(keep).length === Object.keys(a).length ? a : keep;
    });
  }, [view.rules]);
  const mine = model.myPlayers;
  const myIds = mine.map((p) => p.ctl);
  const total = view.slots.filter((s) => s.type !== INPUT_OFF).length;
  const canAdd = mine.length < 4 && total < 10;
  const setMine = (ids: string[]) =>
    model.setMine(ids.map((id) => {
      const s = findSet(g.settings.controls, id);
      const was = mine.find((p) => p.ctl === id);
      return { ctl: id, label: s ? s.name : id, color: was?.color ?? -1, team: was?.team ?? -1 };
    }));
  useJoinListener(canAdd && picker === null, myIds, (id) => {
    setMine([...myIds, id]);
    sound('ok');
  });

  const link = `${location.origin}${location.pathname}?join=${net.code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch {
      toast(`Code: ${net.code}`);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Boom Buds', text: `Join my Boom Buds game! Code ${net.code}`, url: link });
    } catch {
      /* cancelled */
    }
  };
  const start = () => {
    const why = model.check();
    if (why) {
      sound('no');
      return toast(why, true);
    }
    exit({ kind: 'net-match', params: model.start() });
  };
  const hostName = net.memberName(net.hostId);
  // not the host: what the host decides is asked for instead, in the chat (and said here at once)
  const askHost = (change: LobbyChange) => {
    sound('ok');
    toast(`Asked ${hostName}: ${model.ask(change)}`);
  };
  const askRules = (r: Rules) => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const shown: Rules = { ...view.rules, ...asked };
    const delta: Partial<Rules> = {};
    for (const k of Object.keys(r) as (keyof Rules)[]) if (!same(r[k], shown[k])) (delta as Record<string, unknown>)[k] = r[k];
    if (!Object.keys(delta).length) return;
    setAsked((a) => {
      const next: Partial<Rules> = { ...a, ...delta };
      for (const k of Object.keys(delta) as (keyof Rules)[]) if (same(next[k], view.rules[k])) delete next[k];
      return next;
    });
    askHost({ rules: delta });
  };
  const teams = view.slots.filter((s) => s.type !== INPUT_OFF).map((s) => s.team);

  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" onClick={props.onLeave}>◀ Leave</button>
        <div class="grow row" style={{ justifyContent: 'center' }}>
          <span class="muted small">Room</span>
          <span class="code-big">{net.code}</span>
          <button class="btn small" onClick={() => void copy()}>Copy link</button>
          {'share' in navigator && <button class="btn small" onClick={() => void share()}>Share</button>}
        </div>
        {model.isHost ? (
          <button class="btn primary" data-autofocus="" onClick={start}>Start ▶</button>
        ) : (
          <span class="small muted">Waiting for {hostName}…</span>
        )}
      </div>
      <div class="machines">
        <span class="chip"><span class="dot" />{net.name} (you){model.isHost ? ' · host' : ''}</span>
        {net.reconnecting && (
          <span class="chip warn">
            <span class="dot wait" />
            Reconnecting to the game…
          </span>
        )}
        {net.members.map((m) => (
          <span class={`chip ${m.open && m.stale ? 'warn' : ''}`}>
            <span class={`dot ${m.open && !m.stale ? '' : 'wait'}`} />
            {m.name}
            {m.id === net.hostId ? ' · host' : ''}
            {!m.open ? ' · connecting' : m.stale ? ' · connection lost…' : ` · ${Math.round(net.rtt(m.id))} ms`}
            {model.isHost && (
              <button class="chip-x" aria-label={`remove ${m.name} from the game`} title="Remove from the game" onClick={() => setKickFor(m.id)}>
                ✕
              </button>
            )}
          </span>
        ))}
        {model.isHost && (
          <button class="chip linkish" onClick={() => model.setLanVisible(!g.settings.lanVisible)}>
            {g.settings.lanVisible ? '📡 Listed on your network' : '🔒 Not listed (code only)'}
          </button>
        )}
      </div>
      <div class="body cols-2">
        <div class="panel scroll">
          <h2>Players</h2>
          {!!view.rules.teamPlay && <TeamBalance white={teams.filter((t) => t === 0).length} red={teams.filter((t) => t === 1).length} />}
          <div class="players">
            {view.slots.map((s, i) => {
              if (s.type === INPUT_OFF || s.type === INPUT_AI) return null;
              const team = view.rules.teamPlay ? s.team : undefined;
              // everybody sets their own players' colours and teams
              const ownIndex = s.owner === net.myId ? myIds.indexOf(s.ctl ?? '') : -1;
              const own = ownIndex >= 0;
              const me = own ? mine[ownIndex] : null;
              return (
                <PlayerCard
                  slot={i}
                  name={net.memberName(s.owner)}
                  set={own ? findSet(g.settings.controls, s.ctl ?? '') : null}
                  note={own ? undefined : view.labels[i] || 'remote player'}
                  team={team}
                  onTeam={me ? () => model.setMyLook(me.ctl, withTeam({ color: me.color, team: me.team }, s.team ^ 1)) : undefined}
                  onColor={me ? () => setColorFor({ ctl: me.ctl, slot: i }) : undefined}
                  onPickSet={own ? () => setPicker(ownIndex) : undefined}
                  onRemove={own && mine.length > 1 ? () => setMine(myIds.filter((_, k) => k !== ownIndex)) : undefined}
                />
              );
            })}
            {canAdd && <button class="pcard add" onClick={() => setPicker(-1)}>＋ Add a player on this device</button>}
          </div>
          {!mine.length && <div class="small muted">You are watching. Add a player to play from this device.</div>}
          <h2>Computer players</h2>
          <div class="players">
            {view.slots.map((s, i) => {
              if (s.type !== INPUT_AI) return null;
              // the host sets the computer players' colours and teams (the others ask for their skill)
              const k = view.botOf[i] ?? -1;
              const look = model.botLook(k);
              const host = model.isHost && k >= 0;
              return (
                <BotCard
                  slot={i}
                  skill={s.ai}
                  team={view.rules.teamPlay ? s.team : undefined}
                  onTeam={host ? () => model.setBotLook(k, withTeam(look, s.team ^ 1)) : undefined}
                  onColor={host ? () => setColorFor({ bot: k, slot: i }) : undefined}
                  onSkill={host ? (v) => model.setBotSkill(k, v) : k >= 0 ? (v) => askHost({ botSkill: { k, skill: v } }) : undefined}
                  onRemove={host ? () => model.removeBot(k) : k >= 0 ? () => askHost({ removeBot: k }) : undefined}
                />
              );
            })}
            {model.isHost && total < 10 && (
              <button class="pcard add" onClick={() => model.addBot(model.botSkills.length ? model.botSkills[model.botSkills.length - 1] : AI_DEFAULT)}>
                ＋ Add computer player
              </button>
            )}
            {!model.isHost && total < 10 && (
              <button class="pcard add" onClick={() => askHost({ addBot: AI_DEFAULT })}>
                ＋ Ask for a computer player
              </button>
            )}
          </div>
        </div>
        <RulesPanel
          rules={view.rules}
          asked={model.isHost ? undefined : asked}
          note={model.isHost ? undefined : `${hostName} decides: your changes are sent as requests`}
          onChange={model.isHost ? (r) => model.setRules(r) : askRules}
        />
      </div>
      <LobbyChat model={model} />
      {picker !== null && (
        <ControlPicker
          current={picker >= 0 ? myIds[picker] : null}
          used={myIds}
          onClose={() => setPicker(null)}
          onPick={(id) => {
            setMine(picker >= 0 ? myIds.map((x, k) => (k === picker ? id : x)) : [...myIds, id]);
            setPicker(null);
          }}
        />
      )}
      {kickFor !== null && (
        <Modal title={`Remove ${net.memberName(kickFor)}?`} onClose={() => setKickFor(null)}>
          <div class="muted">{net.memberName(kickFor)} leaves the game at once, with their players.</div>
          <div class="row">
            <button
              class="btn danger"
              data-autofocus=""
              onClick={() => {
                model.kick(kickFor);
                setKickFor(null);
              }}
            >
              Remove
            </button>
            <button class="btn" onClick={() => setKickFor(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {colorFor && (
        <ColorPicker
          current={colorFor.slot}
          takenBy={view.slots.map((x, c) => (x.type === INPUT_KEY && c !== colorFor.slot ? net.memberName(x.owner) : null))}
          onClose={() => setColorFor(null)}
          onPick={(c) => {
            if (colorFor.bot !== undefined) model.setBotLook(colorFor.bot, withColor(model.botLook(colorFor.bot), c));
            else {
              const me = mine.find((p) => p.ctl === colorFor.ctl);
              if (me) model.setMyLook(me.ctl, withColor({ color: me.color, team: me.team }, c));
            }
            setColorFor(null);
          }}
        />
      )}
    </div>
  );
}
