// Content-based cache busting. GitHub Pages serves every file with a 10-minute cache and nothing can change
// that, so the build makes every URL change with its content:
//  - code, styles, fonts and menu pictures already have a content hash in their file names (Vite);
//  - the game data (public/data, tens of MB) keeps its file names, and production builds give each file's URL
//    a ?v=<hash of the file> (module virtual:boombuds-data, used by src/engine/assets.ts): a changed file is
//    downloaded again, an unchanged one stays in the browser's cache;
//  - the icons and the web manifest linked from index.html get the same query;
//  - index.html carries a build id, a hash of its own content (which names every hashed file) and of the
//    data hashes; the build also writes it to version.json, which the running game compares with its own
//    (src/app/update.ts) to load a newer build as soon as one is online.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

const VIRTUAL = 'virtual:boombuds-data';
const RESOLVED = '\0' + VIRTUAL;

function hashOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 10);
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

/** Content hash (10 hex digits) of every file under `dir`, by path relative to it with forward slashes. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filesUnder(dir).sort()) out[relative(dir, f).split('\\').join('/')] = hashOf(readFileSync(f));
  return out;
}

export function versioning(): Plugin {
  let config: ResolvedConfig;
  let dataHashes: Record<string, string> = {};
  let buildId = '';
  const building = () => config.command === 'build' && !config.isWorker;
  return {
    name: 'boombuds-versioning',
    configResolved(c) {
      config = c;
    },
    buildStart() {
      if (building()) dataHashes = hashTree(join(config.publicDir, 'data'));
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      // the dev server always serves the current files: no query needed there
      if (id === RESOLVED) return `export default ${JSON.stringify(building() ? dataHashes : {})};`;
      return null;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!building()) return html;
        html = html.replace(/href="\.\/([^"?#]+\.(?:png|ico|svg|webmanifest))"/g, (all, path: string) => {
          try {
            return `href="./${path}?v=${hashOf(readFileSync(join(config.publicDir, path)))}"`;
          } catch {
            return all;
          }
        });
        buildId = createHash('sha256').update(html).update(JSON.stringify(dataHashes)).digest('hex').slice(0, 12);
        return html.replace('</head>', `  <meta name="boombuds-build" content="${buildId}" />\n  </head>`);
      },
    },
    closeBundle() {
      if (!building() || !buildId) return;
      writeFileSync(join(resolve(config.root, config.build.outDir), 'version.json'), `${JSON.stringify({ build: buildId })}\n`);
    },
  };
}
