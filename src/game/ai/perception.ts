// What a bot believes about the bombs on the field. Human-like reaction time is modelled as perception delay:
// a new bomb is only an obstacle (its blast unknown) until `reactMs` have passed, and a change of state
// (kicked, punched, landed, grabbed) is only noticed after the same delay; meanwhile the bot keeps its old
// belief. Weak levels also miss chain reactions and moving bombs, notice other players' blasts late (warnMs),
// think those go off later than they do and misjudge how far they reach.

import { MAX_BOMBS, BombState, BombType } from '../sim/types.ts';
import type { World } from './world.ts';
import { makeSpec, type BombSpec } from './danger.ts';
import type { Profile } from './profile.ts';
import type { Rng } from './rng.ts';
import { msToSteps, stepsUntil } from './timing.ts';

/** steps after which a remote trigger bomb is assumed to go off (the owner reacts to us being in range) */
export const TRIGGER_GRACE = 4;
/** own trigger bombs are treated as going off after a normal fuse, then at any moment after this grace */
export const OWN_TRIGGER_FUSE = 120;
export const OWN_TRIGGER_GRACE = 40;

const F_NOCHAIN = 1;
const F_MOVEBLIND = 2;
/** its blast is believed to reach one cell less than it does */
const F_SHORT = 4;

export class Perception {
  private born = new Int32Array(MAX_BOMBS).fill(-1);
  private first = new Int32Array(MAX_BOMBS);
  private change = new Int32Array(MAX_BOMBS);
  private lastState = new Int8Array(MAX_BOMBS);
  private lastDir = new Int8Array(MAX_BOMBS);
  private lastHolder = new Int8Array(MAX_BOMBS);
  /** cell where the bomb was when its current state was last noticed */
  private seenCell = new Int16Array(MAX_BOMBS);
  private flags = new Uint8Array(MAX_BOMBS);
  private noticed = new Uint8Array(MAX_BOMBS);
  private pool: BombSpec[] = [];
  /** bombs as believed, rebuilt by update() */
  readonly specs: BombSpec[] = [];
  /** changes whenever the belief changes in a way that should trigger a re-plan */
  version = 0;

  reset(): void {
    this.born.fill(-1);
    this.noticed.fill(0);
    this.version++;
  }

  update(w: World, me: number, prof: Profile, rng: Rng): void {
    const tick = w.tick;
    const react = prof.reactMs > 0 ? msToSteps(prof.reactMs) : 0;
    this.specs.length = 0;
    let used = 0;
    for (const b of w.bombs) {
      const i = b.slot;
      if (this.born[i] !== b.born) {
        this.born[i] = b.born;
        this.first[i] = tick;
        this.change[i] = tick;
        this.lastState[i] = b.state;
        this.lastDir[i] = b.dir;
        this.lastHolder[i] = b.holder;
        this.seenCell[i] = b.cell;
        this.noticed[i] = 0;
        let f = 0;
        if (rng.chance(prof.chainBlind)) f |= F_NOCHAIN;
        if (rng.chance(prof.moveBlind)) f |= F_MOVEBLIND;
        // our own bombs we know better (we picked up the flame power-ups ourselves): only a plain mistake
        if (rng.chance(b.owner === me ? prof.mistake : prof.rangeBlind)) f |= F_SHORT;
        this.flags[i] = f;
      } else if (b.state !== this.lastState[i] || b.dir !== this.lastDir[i] || b.holder !== this.lastHolder[i]) {
        this.change[i] = tick;
        this.lastState[i] = b.state;
        this.lastDir[i] = b.dir;
        this.lastHolder[i] = b.holder;
      }
      const own = b.owner === me;
      const delay = own ? 0 : react;
      const known = tick - this.first[i] >= delay;
      const current = tick - this.change[i] >= delay;
      if (current) {
        if (this.seenCell[i] !== b.cell && b.state !== BombState.SLIDING && b.state !== BombState.FLYING) this.version++;
        this.seenCell[i] = b.cell;
      }
      const note = (known ? 1 : 0) | (current ? 2 : 0);
      if (note !== this.noticed[i]) {
        this.noticed[i] = note;
        this.version++;
      }
      if (b.state === BombState.HELD) continue;
      if (used >= this.pool.length) this.pool.push(makeSpec());
      const sp = this.pool[used++];
      sp.slot = i;
      sp.owner = b.owner;
      sp.type = b.type;
      sp.flame = (this.flags[i] & F_SHORT) !== 0 && b.flame > 1 ? b.flame - 1 : b.flame;
      sp.track = null;
      sp.alt = null;
      sp.tOwn = b.tOwn;
      sp.from = -Infinity;
      sp.forever = false;
      sp.blind = false;
      sp.noChain = (this.flags[i] & F_NOCHAIN) !== 0;
      sp.cell = b.cell;
      if (!known) {
        // seen as an object, its danger not yet understood
        sp.blind = true;
        sp.noChain = true;
        if (b.state === BombState.FLYING) continue;
      } else if (!current) {
        // keeps believing the old state: resting where it was last noticed
        sp.cell = this.seenCell[i];
      } else if (b.state === BombState.FLYING || b.state === BombState.SLIDING || (b.cell >= 0 && w.conv[b.cell] >= 0)) {
        if ((this.flags[i] & F_MOVEBLIND) !== 0 && b.state !== BombState.FLYING) {
          sp.cell = b.cell;
        } else {
          sp.track = w.trackOf(b, false);
          sp.alt = w.trackOf(b, true);
          if (b.state === BombState.FLYING && sp.track) {
            // the fuse resumes after landing
            const land = sp.track.land;
            sp.tOwn = land === Infinity ? Infinity : land - 1 + stepsUntil(land - 1, b.fuseLeft);
          }
        }
      }
      if (b.type === BombType.TRIGGER && !b.queued) {
        const o = b.owner >= 0 && b.owner < w.players.length ? w.players[b.owner] : null;
        if (own) {
          // our own trigger: keep out of its blast (as if it had a normal fuse) so we can always detonate it
          sp.tOwn = Math.max(b.born + OWN_TRIGGER_FUSE, tick + 1 + OWN_TRIGGER_GRACE);
          sp.forever = true;
        } else if (o && o.alive) {
          sp.tOwn = tick + 1 + TRIGGER_GRACE;
          sp.forever = true;
        } else {
          sp.tOwn = Infinity;
        }
      }
      if (!own && prof.warnMs !== Infinity && b.fuseLeft > prof.warnMs && b.type !== BombType.TRIGGER) sp.blind = true;
      // people think they have more time than they do: other players' bombs are believed to go off later
      if (!own && prof.timeBlind > 0 && sp.tOwn !== Infinity && !b.queued && b.type !== BombType.TRIGGER) sp.tOwn += msToSteps(prof.timeBlind);
      if (sp.cell < 0 && !sp.track) continue;
      this.specs.push(sp);
    }
  }
}
