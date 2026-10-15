// Parsers for the original game's text resources (VALUELST.RES, SOUNDLST.RES, MESSAGES.TXT, *.SCH, EXTRA*.RES, *.CAM).

/** VALUELST.RES: "id,v1[,v2...] ; comment" -> id -> number[] */
export function parseValueList(text: string): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const parts = line.split(',').map((s) => s.trim()).filter((s) => s.length);
    const id = Number(parts[0]);
    if (!Number.isInteger(id)) continue;
    out[id] = parts.slice(1).map(Number);
  }
  return out;
}

/** SOUNDLST.RES: "id,name" -> id -> name */
export function parseSoundList(text: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const m = /^(\d+)\s*,\s*([^\s,]+)/.exec(line);
    if (m) out[Number(m[1])] = m[2];
  }
  return out;
}

/** MESSAGES.TXT: 'id,text' or 'id,"text"' -> id -> text (quotes stripped). */
export function parseMessages(text: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith(';')) continue;
    const m = /^(\d+),(.*)$/.exec(raw);
    if (!m) continue;
    let s = m[2].trim();
    if (s.startsWith('"')) {
      s = s.slice(1);
      const end = s.lastIndexOf('"');
      if (end >= 0) s = s.slice(0, end);
    }
    out[Number(m[1])] = s;
  }
  return out;
}

export interface Scheme {
  file: string;
  version: number;
  name: string;
  density: number;
  /** 11 rows of 15 chars: '#' solid, ':' brick, '.' blank */
  rows: string[];
  /** player start [x, y, team] for players 0..9 */
  starts: [number, number, number][];
  /** powerup overrides: index -> {bornwith, hasOverride, override, forbidden} */
  powerups: { bornwith: number; hasOverride: number; override: number; forbidden: number }[];
}

export function parseScheme(file: string, text: string): Scheme {
  const s: Scheme = { file, version: 0, name: '', density: 0, rows: [], starts: [], powerups: [] };
  const rows: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('-')) continue;
    const kind = line[1].toUpperCase();
    const rest = line.slice(3);
    if (kind === 'V') s.version = Number(rest);
    else if (kind === 'N') s.name = rest;
    else if (kind === 'B') s.density = Number(rest);
    else if (kind === 'R') {
      const comma = rest.indexOf(',');
      const r = Number(rest.slice(0, comma));
      rows[r] = rest.slice(comma + 1);
    } else if (kind === 'S') {
      const p = rest.split(',').map((x) => Number(x.trim()));
      // older files have no team field: scheme_parse then keeps scheme_basic_grid's team, player & 1
      s.starts[p[0]] = [p[1], p[2], p[3] === undefined ? p[0] & 1 : p[3] ? 1 : 0];
    } else if (kind === 'P') {
      const p = rest.split(',').map((x) => x.trim());
      s.powerups[Number(p[0])] = {
        bornwith: Number(p[1]),
        hasOverride: Number(p[2]),
        override: Number(p[3]),
        forbidden: Number(p[4]),
      };
    }
  }
  s.rows = rows;
  return s;
}

export interface ExtraDef {
  kind: 'A' | 'W' | 'C' | 'T';
  args: string[];
}

export function parseExtras(text: string): ExtraDef[] {
  const out: ExtraDef[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line.startsWith('-')) continue;
    const parts = line.slice(1).split(',').map((x) => x.trim());
    const kind = parts[0].toUpperCase() as ExtraDef['kind'];
    out.push({ kind, args: parts.slice(1) });
  }
  return out;
}

export interface CampaignStage {
  name: string;
  level: number;
  scheme: string;
  rovers: number;
  roverSpeed: number;
  ghosts: number;
  ghostSpeed: number;
  ais: number;
  aiDifficulty: number;
}

export function parseCampaign(text: string): CampaignStage[] {
  const out: CampaignStage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line.startsWith('-C,')) continue;
    const p = line.slice(3).split(',').map((x) => x.trim());
    out.push({
      name: p[0], level: Number(p[1]), scheme: p[2], rovers: Number(p[3]), roverSpeed: Number(p[4]),
      ghosts: Number(p[5]), ghostSpeed: Number(p[6]), ais: Number(p[7]), aiDifficulty: Number(p[8]),
    });
  }
  return out;
}
