// Difficulty levels. Each level is a set of knobs on the same engine: perception delay and blind spots,
// planning frequency, safety margins, offensive depth, its decision lag and which power-ups the bot knows how to
// use. The arenas' extras are no matter of skill: every level takes warp holes and rides conveyors as the search
// plans them (and jumps on a trampoline, whose landing is random, when nothing else is left).
//
// The levels are meant to play like people, measured against the original game's computer player (AI 0): 1 a
// beginner who loses to it most of the time, 2 a casual player about even with it who bombs whoever is in line,
// 3 a good player, 4 a strong one, 5 a match for the very best. Reaction and decision times stay human (150 ms and
// about 90 ms for level 5), and the weaker levels lose the way people do, by being slow rather than blowing
// themselves up: they notice an opponent's bomb late, think it goes off later and reaches less far than it does,
// miss chain reactions, react and decide slowly and run into dead ends.

export interface Profile {
  level: number;
  /** delay before a new bomb or a bomb's change of state (kick, punch, landing) is perceived */
  reactMs: number;
  /** periodic re-planning interval in steps (plans are also redone on events) */
  replanSteps: number;
  /** safety margin (steps) around every unsafe interval when planning paths */
  margin: number;
  /** extra margin required for the escape after dropping an own bomb */
  dropMargin: number;
  /** other players' blasts are only perceived with less than this fuse left (Infinity: always) */
  warnMs: number;
  /** chance per bomb that chain reactions setting it off are not anticipated */
  chainBlind: number;
  /** chance per moving bomb that its motion is ignored (treated as resting where first seen) */
  moveBlind: number;
  /** chance per bomb of another player that its blast is believed to reach one cell less than it does */
  rangeBlind: number;
  /** other players' bombs are believed to go off this many ms later than they will ("I thought I had time") */
  timeBlind: number;
  /** chance per own bomb of a misjudged blast (believed one cell short), and per drop with no way out to drop anyway */
  mistake: number;
  /** weight of offensive goals */
  attack: number;
  /** offensive depth: 0 a poke now and then, 1 bombs whoever is in line, 2 single-bomb traps, 3 pressure + combos, 4 deep search */
  trap: number;
  /** extra enemy-escape evaluations per plan (deep trap search budget) */
  trapBudget: number;
  /** steps an enemy is assumed to need to notice a new bomb when judging traps (at least) */
  assumeReact: number;
  /** share of an opponent's real reaction time (bots: their perception delay, humans ~250 ms) counted on */
  foeRead: number;
  kick: boolean;
  punch: boolean;
  trigger: boolean;
  spooge: boolean;
  /** weight of dead-end avoidance when choosing where to stand */
  deadEnd: number;
  /** drops are checked against enemies within this distance answering with a bomb of their own (0: off) */
  threatRange: number;
  /** also prefer targets and havens that stay safe if a nearby enemy drops a bomb */
  threatPlan: boolean;
  /** steps an enemy may walk before dropping its answer bomb (threat candidates) */
  threatHorizon: number;
  /** maximum single enemy bombs tested per threat check */
  threatChecks: number;
  /** enemy bombs tested against a chosen escape path (0: off) */
  pathChecks: number;
  /** enemy bombs tested when judging whether a standing position is safe */
  posChecks: number;
  /** late-game push (0 off .. 1): stop fleeing pre-emptively, accept quicker counters, lower drop thresholds */
  late: number;
  /** drop set-up bombs next to enemies (keeping one for a follow-up) even without a planned combo */
  setup: boolean;
  /** pressure: after this many steps without a bomb, drop one that reaches a nearby enemy (safe drops only) */
  pressGap: number;
  /** chance to take such a pressure drop when one is due (clumsy levels miss some) */
  pressChance: number;
  /** decision lag before laying a bomb, ms (the average: each time 0.5 to 1.5 times it), like a person's */
  dropLag: number;
  /** steps a chosen goal is kept unless another is clearly better (against dithering between two targets) */
  commit: number;
  /** multiplier on power-up values (and whether bad power-ups are recognised) */
  greed: number;
  /** relative random noise on goal utilities (wandering) */
  noise: number;
  /** chance per plan to wander to a random cell instead of the best goal */
  wander: number;
}

const BASE: Profile = {
  level: 3, reactMs: 250, replanSteps: 10, margin: 2, dropMargin: 1, warnMs: Infinity, chainBlind: 0, moveBlind: 0, rangeBlind: 0, timeBlind: 0,
  mistake: 0, attack: 1, trap: 2, trapBudget: 0, assumeReact: 0, foeRead: 0.5, kick: true, punch: false, trigger: true, spooge: false,
  deadEnd: 0.6, threatRange: 4, threatPlan: true, threatHorizon: 20, threatChecks: 5, pathChecks: 0, posChecks: 5, late: 0.25, setup: true, pressGap: 300, pressChance: 1, dropLag: 300, commit: 45, greed: 1, noise: 0.15, wander: 0,
};

/** Tuning hook for tools (arena experiments): per-level overrides in globalThis.__AI_TUNE, e.g. { 5: { trap: 3 } }. */
export function profileFor(level: number): Profile {
  const p = baseProfile(level);
  const tune = (globalThis as { __AI_TUNE?: Record<number, Partial<Profile>> }).__AI_TUNE;
  return tune && tune[level] ? { ...p, ...tune[level] } : p;
}

function baseProfile(level: number): Profile {
  switch (level) {
    case 1:
      return {
        ...BASE, level: 1, reactMs: 900, replanSteps: 26, margin: 1, dropMargin: 0, warnMs: 200, chainBlind: 1, moveBlind: 1, rangeBlind: 0.8, timeBlind: 700,
        mistake: 0.01, attack: 0.05, trap: 0, foeRead: 0, pressGap: 480, pressChance: 0.5, dropLag: 1200, kick: false, trigger: false, deadEnd: 0, threatRange: 0, threatHorizon: 0, threatChecks: 0, pathChecks: 0, posChecks: 0, late: 0, greed: 0.6, noise: 0.6, wander: 0.3,
      };
    case 2:
      return {
        ...BASE, level: 2, reactMs: 650, replanSteps: 18, margin: 1.5, dropMargin: 0.5, warnMs: 250, chainBlind: 0.6, moveBlind: 0.6, rangeBlind: 0.7, timeBlind: 600,
        mistake: 0.005, attack: 0.5, trap: 1, foeRead: 0, pressGap: 240, pressChance: 0.8, dropLag: 900, kick: false, trigger: false, deadEnd: 0, threatRange: 1, threatHorizon: 0, threatChecks: 1, pathChecks: 0, posChecks: 1, late: 0.25, greed: 0.8, noise: 0.35, wander: 0.05,
      };
    case 3:
      return { ...BASE, reactMs: 300, warnMs: 1200, chainBlind: 0.2, rangeBlind: 0.6, threatRange: 2, posChecks: 2 };
    case 4:
      return {
        ...BASE, level: 4, reactMs: 240, replanSteps: 8, chainBlind: 0.15, rangeBlind: 0.3, margin: 2, dropMargin: 1.5, attack: 1.3, trap: 3, trapBudget: 10, assumeReact: 3, foeRead: 0.8, pressGap: 300, dropLag: 180,
        punch: true, spooge: true, deadEnd: 1, threatRange: 5, threatPlan: true, threatHorizon: 20, threatChecks: 8, pathChecks: 4, posChecks: 8, late: 0.5, noise: 0.08,
      };
    default:
      return {
        ...BASE, level: 5, reactMs: 150, replanSteps: 5, margin: 2, dropMargin: 1.5, attack: 1.6, trap: 4, trapBudget: 18, assumeReact: 9, foeRead: 1, pressGap: 300, dropLag: 90,
        punch: true, spooge: true, deadEnd: 1.2, threatRange: 7, threatPlan: true, threatHorizon: 20, threatChecks: 48, pathChecks: 6, posChecks: 12, late: 1, greed: 1.1, noise: 0.03,
      };
  }
}
