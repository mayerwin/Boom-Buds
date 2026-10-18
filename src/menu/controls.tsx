// Controls: the control sets of this device. Gamepads (whole, or either half for two players on one) and the TV
// remote are drawn with the buttons they play with; keyboard sets can be tried, changed, renamed, reset and
// created. On a television the gamepads come first and the keyboard sets only once a keyboard has been used.

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { KeyCapture, setDescription } from './players.tsx';
import { ControllerArt, KeyCluster } from './controller.tsx';
import { BUILTIN_KEY_SETS, availableSets, classicKeySets, isTvApp, keyboardsHere, type ControlSet } from '../app/controls.ts';

export function Controls(): JSX.Element {
  const { g, back, save, toast } = useMenu();
  const st = g.settings;
  const [, redraw] = useState(0);
  const [edit, setEdit] = useState<ControlSet | 'new' | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [lit, setLit] = useState<Set<string>>(new Set());
  // keys light up while held: a quick way to check a layout
  useEffect(() => {
    const down = (e: KeyboardEvent) => setLit((s) => new Set(s).add(e.code));
    const up = (e: KeyboardEvent) => setLit((s) => {
      const n = new Set(s);
      n.delete(e.code);
      return n;
    });
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const t = setInterval(() => redraw((x) => x + 1), 1000); // gamepads come and go
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      clearInterval(t);
    };
  }, []);
  const keyboards = keyboardsHere(g.app.input);
  const keySets = st.controls.sets.filter((s) => s.kind === 'keys');
  // touch sets are listed on touch screens; elsewhere one line says they exist
  const others = availableSets(st.controls, g.app.input, g.app.isTouch).filter((s) => s.kind !== 'keys');
  if (!g.app.isTouch) others.push({ id: 'touch', name: 'Touch controls', kind: 'touch', side: 'both' });
  const pads = g.app.input.gamepads();
  const update = (next: ControlSet) => {
    const i = st.controls.sets.findIndex((s) => s.id === next.id);
    if (i >= 0) st.controls.sets[i] = next;
    else st.controls.sets.push(next);
    save();
    redraw((x) => x + 1);
  };

  const devices = (
    <div class="panel">
      <h2>
        Gamepads, remote and more <span class="hint">two players can share a gamepad, a half each</span>
      </h2>
      <div class="sets">
        {/* each card is a stop of the navigation: nothing in them to press, and they must still be reachable */}
        {others.map((s) => (
          <div class="set-card" tabIndex={0} role="group" aria-label={`${s.name}: ${setDescription(s)}`}>
            <b>{s.name}</b>
            <ControllerArt set={s} />
            <span class="small muted">{setDescription(s)}</span>
          </div>
        ))}
        {!pads.length && (
          <div class="set-card" tabIndex={0}>
            <b>Gamepads</b>
            <span class="small muted">
              Connect a gamepad (USB or Bluetooth) and press one of its buttons: it appears here and in the player
              lists.
            </span>
          </div>
        )}
      </div>
    </div>
  );

  const keyboard = (
    <div class="panel">
      <h2>
        Keyboard sets <span class="hint">{keyboards ? 'keys light up when you press them' : 'a keyboard is not in use here'}</span>
      </h2>
      {keyboards ? (
        <>
          <div class="small muted">
            Up to four players share a keyboard (some keyboards cannot tell many keys held at once apart). In the
            original 1997 menus the sets are KEY 0, KEY 1 and so on, as marked.
          </div>
          <div class="sets">
            {keySets.map((s) => (
              <div class="set-card">
                <div class="row">
                  {renaming === s.id ? (
                    <input
                      class="textin grow"
                      value={s.name}
                      maxLength={24}
                      ref={(el) => el?.focus()}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setRenaming(null); }}
                      onBlur={() => setRenaming(null)}
                      onInput={(e) => update({ ...s, name: (e.target as HTMLInputElement).value || s.name })}
                    />
                  ) : (
                    <b class="grow">
                      {s.name} <span class="small muted">· KEY {classicKeySets(st.controls).indexOf(s)}</span>
                    </b>
                  )}
                  <button class="btn small" onClick={() => setEdit(s)}>Change keys</button>
                  <button class="btn small ghost" onClick={() => setRenaming(s.id)} aria-label={`rename ${s.name}`}>✎</button>
                  {s.builtin ? (
                    <button
                      class="btn small ghost"
                      aria-label={`reset ${s.name}`}
                      onClick={() => {
                        const d = BUILTIN_KEY_SETS.find((b) => b.id === s.id)!;
                        update({ ...d, keys: [...d.keys!] });
                        toast('Back to the default keys');
                      }}
                    >
                      ↺
                    </button>
                  ) : (
                    <button
                      class="btn small ghost danger"
                      aria-label={`delete ${s.name}`}
                      onClick={() => {
                        st.controls.sets = st.controls.sets.filter((x) => x.id !== s.id);
                        save();
                        redraw((x) => x + 1);
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
                <KeyCluster keys={s.keys!} lit={lit} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div class="small muted">
          A keyboard works here too: plug one in (or pair it over Bluetooth) and press a key. Its four sets —
          up to four players on one keyboard — then appear here and in the player lists.
        </div>
      )}
    </div>
  );

  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" data-autofocus="" onClick={back}>◀ Back</button>
        <h1>Controls</h1>
        {keyboards ? (
          <button class="btn primary" onClick={() => setEdit('new')}>＋ New keyboard set</button>
        ) : (
          <span style={{ width: 'calc(var(--tap) * 2)' }} />
        )}
      </div>
      {/* one long column that scrolls as a whole: on a television the panels are taller than the screen */}
      <div class="body flow">
        {isTvApp() ? (
          <>
            {devices}
            {keyboard}
          </>
        ) : (
          <>
            {keyboard}
            {devices}
          </>
        )}
      </div>
      {edit && (
        <KeyCapture
          initial={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(null)}
          onDone={(s) => {
            update(s);
            setEdit(null);
            toast(`${s.name} saved`);
          }}
        />
      )}
    </div>
  );
}
