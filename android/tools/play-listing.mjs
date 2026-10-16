// Google Play, through the Android Publisher API, with the service account whose file path is in PLAY_SA (its key is
// read, never printed or copied). Used by publishing/7-update-play-listing.ps1.
//   node play-listing.mjs tracks
//       the tracks of com.github.boombuds: release names, version codes, statuses
//   node play-listing.mjs listing <store-listing.md> [screenshots dir] [--dry]
//       the en-US listing's short and full descriptions from store-listing.md (its "Short description" and "Full
//       description" sections) and, with a directory, the Android TV screenshots replaced by its PNGs in name order;
//       one edit, committed (--dry: checked, then thrown away)
// Review status is not part of the API: Play Console shows it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSign } from 'node:crypto';

const PACKAGE = 'com.github.boombuds';
const LANGUAGE = 'en-US';
const [command, listingFile, shotsDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--dry');

async function token() {
  const sa = JSON.parse(readFileSync(process.env.PLAY_SA, 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 900 })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const r = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signer.sign(sa.private_key).toString('base64url')}` }),
  })).json();
  if (!r.access_token) throw new Error('Google refused the service account: ' + (r.error ?? 'unknown'));
  return r.access_token;
}

const auth = { authorization: `Bearer ${await token()}` };
const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const upload = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

/** One API call; the service's own hiccups (5xx) are tried again a few times. */
async function call(method, url, body, type = 'application/json') {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method, headers: body ? { ...auth, 'content-type': type } : auth, body: body && type === 'application/json' ? JSON.stringify(body) : body });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : {};
    if (r.status >= 500 && attempt < 4) {
      await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method} ${url.replace(/^.*applications\//, '')}: ${r.status} ${text.slice(0, 400)}`);
  }
}

/** Runs `work` in a new edit; commits it unless `keep` is false (the edit is deleted then, or on failure). */
async function inEdit(work, keep) {
  const edit = await call('POST', `${base}/edits`);
  let committed = false;
  try {
    await work(edit.id);
    if (keep) {
      await call('POST', `${base}/edits/${edit.id}:commit`);
      committed = true;
    }
  } finally {
    if (!committed) await call('DELETE', `${base}/edits/${edit.id}`).catch(() => {});
  }
  return committed;
}

if (command === 'tracks') {
  await inEdit(async (id) => {
    const { tracks } = await call('GET', `${base}/edits/${id}/tracks`);
    for (const t of tracks ?? []) {
      if (!t.releases?.length) console.log(`${t.track}: no release`);
      for (const r of t.releases ?? []) console.log(`${t.track}: ${r.name ?? '?'} (code ${(r.versionCodes ?? []).join(', ')}), ${r.status}`);
    }
  }, false);
} else if (command === 'listing' && listingFile) {
  const md = readFileSync(listingFile, 'utf8').replace(/\r\n/g, '\n');
  const section = (heading, next) => {
    const a = md.indexOf(`## ${heading}`);
    const b = md.indexOf(`\n## ${next}`, a + 1);
    if (a < 0 || b < 0) throw new Error(`no "${heading}" section in ${listingFile}`);
    return md.slice(md.indexOf('\n', a) + 1, b).trim();
  };
  const shortDescription = section('Short description', 'Full description');
  const fullDescription = section('Full description', 'Release notes');
  if (shortDescription.length > 80) throw new Error(`the short description has ${shortDescription.length} characters (80 at most)`);
  if (fullDescription.length > 4000) throw new Error(`the full description has ${fullDescription.length} characters (4000 at most)`);
  const shots = shotsDir ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort() : [];
  console.log(`short description (${shortDescription.length}): ${shortDescription}`);
  console.log(`full description: ${fullDescription.length} characters; TV screenshots: ${shots.join(', ') || 'unchanged'}`);
  const committed = await inEdit(async (id) => {
    await call('PATCH', `${base}/edits/${id}/listings/${LANGUAGE}`, { shortDescription, fullDescription });
    if (!shots.length) return;
    await call('DELETE', `${base}/edits/${id}/listings/${LANGUAGE}/tvScreenshots`);
    for (const f of shots) {
      await call('POST', `${upload}/edits/${id}/listings/${LANGUAGE}/tvScreenshots?uploadType=media`, readFileSync(join(shotsDir, f)), 'image/png');
      console.log(`uploaded ${f}`);
    }
  }, !dry);
  console.log(committed ? 'Committed: Google Play reviews the listing change.' : 'Dry run: nothing changed on Google Play.');
} else {
  console.error('usage: node play-listing.mjs tracks | listing <store-listing.md> [screenshots dir] [--dry]');
  process.exitCode = 2;
}
