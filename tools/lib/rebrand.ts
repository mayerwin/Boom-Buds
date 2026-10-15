// Text changes for the Boom Buds branding (and for facts that differ in the web version), applied by
// tools/extract.ts to MESSAGES.TXT and the online manual (.BM files). Whole replacement help files live in
// tools/brand/help/. Every rule is an exact phrase so that nothing else changes; the extraction fails if a
// rule no longer matches (data drift).

type Rule = [from: string, to: string];

/** MESSAGES.TXT ids -> new text */
export const MESSAGE_OVERRIDES: Record<number, string> = {
  256: 'Gold Bud: %s',
  500: 'Boom Bud',
  700: 'Boom Buds Level Editor',
  900: 'Boom Buds Statistics File:',
  1300: 'Please select Boom Buds memory model:',
  1321: 'exit and restart Boom Buds. Do you want to do this?',
  1323: 'exit and restart Boom Buds. Do you want to do this?',
};

/** scheme file -> new internal name (shown by the scheme chooser) */
export const SCHEME_NAME_OVERRIDES: Record<string, string> = {
  'BMAN93.SCH': "Buds '93 (10)",
};

const HELP_RULES: Record<string, Rule[]> = {
  'CREDITS.BM': [
    ['Atomic Bomberman Credits', 'Boom Buds Credits'],
    ['Atomic Bomberman Animation\'s & 3D Modeling:', 'Animation\'s & 3D Modeling:'],
    ['\tand the Interplay Bomberman Fanatics.', '\tand all the Fanatics.'],
  ],
  'EDITOR.BM': [
    ['Atomic Bomberman Secret Level Editor Help', 'Boom Buds Secret Level Editor Help'],
    ['Atomic Bomberman has a built-in level editor that may', 'Boom Buds has a built-in level editor that may'],
    ['To activate the Atomic Bomberman Level Editor you need', 'To activate the Boom Buds Level Editor you need'],
    ['  Q) Exit. (This exits back to the Bomberman ', '  Q) Exit. (This exits back to the Boom Buds '],
    ['Atomic Bomberman Editor Key Reference', 'Boom Buds Editor Key Reference'],
  ],
  'HIGHMEM.BM': [
    ['Running Atomic Bomberman in high-memory configurations', 'Running Boom Buds in high-memory configurations'],
    ['      background before running Bomberman.', '      background before running Boom Buds.'],
    ['   during gameplay.  Music in Bomberman is staged', '   during gameplay.  Music in Boom Buds is staged'],
  ],
  'LOWMEM.BM': [
    ['Running Atomic Bomberman in low-memory configurations', 'Running Boom Buds in low-memory configurations'],
    ['      background before running Bomberman.', '      background before running Boom Buds.'],
    ['   during gameplay.  Music in Bomberman is staged', '   during gameplay.  Music in Boom Buds is staged'],
  ],
  'MANUAL.BM': [
    ['ATOMIC BOMBERMAN ON-LINE MANUAL', 'BOOM BUDS ON-LINE MANUAL'],
    ['For those of you not familiar with the Bomberman ', 'For those of you not familiar with the Boom Buds '],
    ['To move your bomberman around just press in the direction ', 'To move your bud around just press in the direction '],
    ['you would like your bomberman to move.  Basically, there ', 'you would like your bud to move.  Basically, there '],
    ['bomberman--Drop Bomb and Action Button.', 'bud--Drop Bomb and Action Button.'],
    ['  if your bomberman has the Kick powerup, press the ', '  if your bud has the Kick powerup, press the '],
    ['for the bombermen in the game.  Move the cursor (the head) ', 'for the buds in the game.  Move the cursor (the head) '],
    ['to the right of the screen.  To remove a bomberman, press ', 'to the right of the screen.  To remove a bud, press '],
    [
      "assign a Bomberman AI to a player, press [right] until the \nplayer is selected on 'AI.'  In order to start a Bomberman ",
      // (same number of lines: the viewer's pages must not shift)
      "assign an AI to a player, press [right] until the player \nshows 'AI 1' to 'AI 5' (skill: keys 1-5).  To start a Boom Buds ",
    ],
    ['This option allows bombermen of all ages to host a game on', 'This option allows buds of all ages to host a game on'],
    ['an IPX, modem, or serial network.  Upon selecting this ', 'your local network (see NETWORK.BM).  Upon selecting this '],
    ['bombermen join your network game, they will be listed on ', 'buds join your network game, they will be listed on '],
    ['Gold Bomberman:  (Yes/No)  The Gold Bomberman is a reward', 'Gold Bud:  (Yes/No)  The Gold Bud is a reward'],
    ['  A favorite Interplay past time. Assemble your team and ', '  A favorite office past time. Assemble your team and '],
    ['  for use with a Network Modem game of Bomberman.    Use ', '  for use with a Network Modem game (not used by Boom Buds).  Use '],
    ['About Bomberman', 'About Boom Buds'],
    ['files and information files on Bomberman.  You should', 'files and information files on Boom Buds.  You should'],
    ['This will end your current session of Atomic Bomberman.  ', 'This will end your current session of Boom Buds.  '],
    ['Standard Bomberman Equipment (Powerups)', 'Standard Bud Equipment (Powerups)'],
    ['<IMGpowslow> Brake.  Slows down your Bomberman. ', '<IMGpowslow> Brake.  Slows down your bud. '],
    ['\t\t(option only available through Gold Bomberman)', '\t\t(option only available through Gold Bud)'],
    ['All bombermen cannot have everything in life, so some', 'All buds cannot have everything in life, so some'],
    ['bomberman to grab.  For instance, if a bomberman already', 'bud to grab.  For instance, if a bud already'],
    ['to Bombermen.  If a Bomberman dies, powerups possessed ', 'to buds.  If a bud dies, powerups possessed '],
    ['bombermen to loot.  Remember, if powerups get blown', 'buds to loot.  Remember, if powerups get blown'],
  ],
  'OPTIONS.BM': [
    ['Gold Bomberman:  (Yes/No)  The Gold Bomberman is a reward', 'Gold Bud:  (Yes/No)  The Gold Bud is a reward'],
    ['  A favorite Interplay past time. Assemble your team and ', '  A favorite office past time. Assemble your team and '],
    ['  for use with a Network Modem game of Bomberman.    Use ', '  for use with a Network Modem game (not used by Boom Buds).  Use '],
  ],
  'ROULETTE.BM': [
    ['Gold Bomberman Roulette Wheel Screen Help', 'Gold Bud Roulette Wheel Screen Help'],
    ['If you have the Gold Bomberman Option selected to ', 'If you have the Gold Bud Option selected to '],
    ['Game (the Gold Bomberman Roulette Wheel).  From this ', 'Game (the Gold Bud Roulette Wheel).  From this '],
    ['Bomberman will get for the following match.  The ', 'Bud will get for the following match.  The '],
    ['Gold Bomberman is the player/team who won the last ', 'Gold Bud is the player/team who won the last '],
    ['Bomberman slower.', 'bud slower.'],
  ],
};

function applyRules(name: string, text: string, rules: Rule[]): string {
  // rules are written against LF line endings; keep the file's own line endings
  const crlf = text.includes('\r\n');
  let t = crlf ? text.replace(/\r\n/g, '\n') : text;
  for (const [from, to] of rules) {
    if (!t.includes(from)) throw new Error(`rebrand: '${from}' not found in ${name}`);
    t = t.split(from).join(to);
  }
  return crlf ? t.replace(/\n/g, '\r\n') : t;
}

export function rebrandHelp(name: string, text: string): string {
  const rules = HELP_RULES[name.toUpperCase()];
  return rules ? applyRules(name, text, rules) : text;
}

export function rebrandMessages(messages: Record<string, string>): Record<string, string> {
  const out = { ...messages };
  for (const [id, text] of Object.entries(MESSAGE_OVERRIDES)) {
    if (!(id in out)) throw new Error(`rebrand: message ${id} not found`);
    out[id] = text;
  }
  return out;
}

/** Any remaining mention of the original product name (checked after rebranding). */
export function findOriginalBrand(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => /bomberm[ae]n|atomic bomber/i.test(l));
}
