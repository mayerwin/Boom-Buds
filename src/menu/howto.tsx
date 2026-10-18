// How to play: the goal, the buttons, every power-up (with its sprite), diseases and arena features.

import type { JSX } from 'preact';
import { useMenu } from './ctx.ts';
import { keysSummary } from '../app/controls.ts';

const POWERS: [string, string, string][] = [
  ['bomb', 'Extra Bomb', 'one more bomb at a time'],
  ['flame', 'Extended Flame', 'longer explosions'],
  ['goldflame', 'Golden Flame', 'explosions of maximum length'],
  ['skate', 'Skate', 'run faster'],
  ['kicker', 'Kick', 'walk into a bomb to kick it; Special stops it'],
  ['punch', 'Boxing Glove', 'Special punches the bomb in front of you over walls'],
  ['grab', 'Blue Hand', 'Bomb on your own bomb picks it up; release to throw'],
  ['spooge', 'Spooge', 'Bomb twice lays all your bombs in a line'],
  ['trigger', 'Trigger', 'your bombs wait; Special sets them off'],
  ['jelly', 'Jelly', 'your bombs bounce off walls'],
  ['disease', 'Disease', 'catch one disease (pass it on by touching others)'],
  ['disease3', 'Super Bad Disease', 'three diseases at once'],
  ['random', 'Random', 'any of the above'],
  ['clog', 'Brake', 'slower (only from the Gold Bud wheel)'],
];

export function HowTo(): JSX.Element {
  const { g, back, art } = useMenu();
  const sets = g.settings.controls.sets.filter((s) => s.kind === 'keys');
  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" data-autofocus="" onClick={back}>◀ Back</button>
        <h1>How to Play</h1>
        <span style={{ width: 'calc(var(--tap) * 2)' }} />
      </div>
      {/* the panels are stops of their own: with nothing to press in them, the arrows would never reach their
          text on a television (src/menu/nav.ts data-scroller) */}
      <div class="body cols-2">
        <div class="panel scroll prose" tabIndex={0} data-scroller="" role="group" aria-label="how to play">
          <h3>Goal</h3>
          <p>Blow up the bricks, grab power-ups and be the last bud standing. Winning a round scores a point; the first to the number of wins set for the match takes it.</p>
          <h3>Buttons</h3>
          <p>Every player has a direction, a <b>Bomb</b> button and a <b>Special</b> button (stops kicked bombs, punches, sets off trigger bombs).</p>
          {sets.map((s) => (
            <p class="small">
              <b>{s.name}:</b> {keysSummary(s.keys!)} <span class="muted">(move · bomb special)</span>
            </p>
          ))}
          <p class="small"><b>Gamepad:</b> stick or d-pad, A bomb, B special. Two players can share one, a half each: on the left side the left stick or d-pad, LB bomb, LT special; on the right side the right stick, A or RB bomb, X or RT special. The Controls menu draws every controller with its buttons marked.</p>
          <p class="small"><b>TV remote:</b> arrows, OK bomb, hold OK for the special. <b>Touch:</b> on-screen stick, A bomb, B special. <b>Mouse:</b> point where to walk, left button bomb, right button special.</p>
          <p class="small muted">During a round: Esc (or a gamepad's Start) pauses · F10 ends the round in a draw · Ctrl-Q leaves the match. When only computer players are left: ← → (or the d-pad) change the speed, ↑ ↓ pause.</p>
          <h3>Diseases</h3>
          <p class="small">Slow legs, too fast, no bombs, bombs everywhere, short flame, short fuse, reversed controls, swapped places… Touch another bud to pass it on, or wait for it to wear off.</p>
          <h3>Arenas</h3>
          <p class="small">Arrows turn kicked bombs, conveyor belts carry everyone along, warp holes teleport you, trampolines throw you over the walls. When time runs out, the walls close in.</p>
        </div>
        <div class="panel scroll" tabIndex={0} data-scroller="" role="group" aria-label="power-ups">
          <h2>Power-ups</h2>
          <div class="powers">
            {POWERS.map(([id, name, what]) => (
              <div class="power">
                <img src={art.powers[id]} alt="" />
                <div>
                  <b>{name}</b>
                  <div class="small muted">{what}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
