// Local server (optional): serves the built game (dist/) to this computer and the others of its network, with
// a relay for the room handshake, so that network games work without internet (LAN parties). Normally the
// game is played from its website and players meet through public relays; no server is needed. Game traffic
// never goes through this server once the machines are connected.
//
//   npm run build && npm run lan [-- --open]     (port 8080, or the next free one; PORT=xxxx to choose)
//   npm start                                     (the same, building first when needed: tools/launch.ts)
//
// Pages served here meet through this server's relay (a meta tag in index.html; ?relay=public overrides it).
// File names are matched case-sensitively, like GitHub Pages does.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { attachSignaling } from './signaling.ts';
import { fileURLToPath } from 'node:url';

const FIRST_PORT = Number(process.env.PORT ?? 8080);
const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..', process.env.DIST ?? 'dist'));
const OPEN = process.argv.includes('--open');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.gz': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.pal': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

/** Does `path` (relative to ROOT, with forward slashes) exist with exactly this upper / lower case? */
async function exactCase(path: string): Promise<boolean> {
  let dir = ROOT;
  for (const part of path.split('/').filter(Boolean)) {
    try {
      if (!(await readdir(dir)).includes(part)) return false;
    } catch {
      return false;
    }
    dir = join(dir, part);
  }
  return true;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    res.writeHead(403).end();
    return;
  }
  try {
    const st = await stat(file);
    if (!st.isFile() || !(await exactCase(path))) throw new Error('not found');
    const isPage = path.endsWith('/index.html');
    // revalidation: the game data (tens of MB) is only sent again when it changed
    const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
    const since = req.headers['if-modified-since'];
    if (!isPage && since && Date.parse(since) >= Math.floor(st.mtimeMs / 1000) * 1000) {
      res.writeHead(304, { 'Last-Modified': lastModified }).end();
      return;
    }
    let data = await readFile(file);
    if (isPage) {
      // the pages of this server meet through its relay
      const html = data.toString('utf8').replace('</head>', '  <meta name="boombuds-relay" content="local" />\n  </head>');
      data = Buffer.from(html, 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Last-Modified': lastModified,
      'Cache-Control': path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    // (not the self-assigned 169.254.x.x addresses of disconnected adapters)
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref();
  } catch {
    /* no browser to open: the address is printed */
  }
}

const server = createServer((req, res) => {
  void serveStatic(req, res);
});
attachSignaling(server);

let port = FIRST_PORT;
server.on('error', (e: NodeJS.ErrnoException) => {
  // the port is taken (another server, or Boom Buds already running): try the next ones
  if (e.code === 'EADDRINUSE' && !process.env.PORT && port < FIRST_PORT + 20) server.listen(++port);
  else {
    console.error(`Cannot start the server: ${e.message}`);
    process.exit(1);
  }
});
server.on('listening', () => {
  const local = `http://localhost:${port}/`;
  console.log('');
  console.log('  Boom Buds is running');
  console.log('');
  console.log(`  On this computer:   ${local}`);
  for (const ip of lanAddresses()) console.log(`  Other devices:      http://${ip}:${port}/`);
  console.log('');
  console.log('  Network games meet through this computer, so they work without internet too.');
  console.log('  Keep this window open while you play; close it or press Ctrl+C to stop.');
  console.log(`  (serving ${ROOT})`);
  console.log('');
  if (OPEN) openBrowser(local);
});
server.listen(port);
