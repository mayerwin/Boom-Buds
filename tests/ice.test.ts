// The servers a network connection tries: public STUN, then the TURN relays of a credentials API (src/net/mesh.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RelayList, iceServers, parseIceServers, RELAY_TTL_MS, RELAY_TIMEOUT_MS } from '../src/net/mesh.ts';

const URL = 'https://relay.example/api/v1/turn/credentials?apiKey=test';
const METERED = [
  { urls: 'stun:stun.relay.example:80' },
  { urls: 'turn:global.relay.example:80', username: 'u', credential: 'c' },
  { urls: 'turn:global.relay.example:443?transport=tcp', username: 'u', credential: 'c' },
  { urls: 'turns:global.relay.example:443?transport=tcp', username: 'u', credential: 'c' },
];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** A credentials API that answers `answers` in turn (an Error: the request fails), counting the requests. */
function api(...answers: (unknown | Error)[]) {
  const calls: RequestInit[] = [];
  const get = async (url: string, init: RequestInit) => {
    expect(url).toBe(URL);
    calls.push(init);
    const a = answers[Math.min(calls.length, answers.length) - 1];
    if (a instanceof Error) throw a;
    return a instanceof Response ? a : json(a);
  };
  return { get, calls };
}

const urls = (list: RTCIceServer[]) => list.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

afterEach(() => vi.useRealTimers());

describe('ICE servers', () => {
  it('without a credentials API: the public STUN servers only', async () => {
    const list = await iceServers(null);
    expect(list).toHaveLength(1);
    expect(urls(list).every((u) => u.startsWith('stun:'))).toBe(true);
  });

  it('adds the relays of an API that answers with an array, after the STUN servers', async () => {
    const a = api(METERED);
    const list = await iceServers(new RelayList(URL, a.get));
    expect(urls([list[0]])).toEqual(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']);
    expect(list.slice(1)).toEqual(METERED.map((s) => ({ ...s, urls: [s.urls] })));
    expect(urls(list).filter((u) => /^turns?:/.test(u))).toHaveLength(3);
    expect(a.calls[0].cache).toBe('no-store');
    expect(a.calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts { iceServers: [...] } too', async () => {
    const a = api({ iceServers: METERED.slice(1) });
    const list = await iceServers(new RelayList(URL, a.get));
    expect(urls(list.slice(1))).toEqual(METERED.slice(1).map((s) => s.urls));
    expect(list[1]).toMatchObject({ username: 'u', credential: 'c' });
  });

  it('keeps the list for 30 minutes, then asks again', async () => {
    let now = 1000;
    const a = api(METERED, { iceServers: [METERED[1]] });
    const relays = new RelayList(URL, a.get, () => now);
    await relays.load();
    now += RELAY_TTL_MS - 1;
    expect(await relays.load()).toHaveLength(4);
    expect(a.calls).toHaveLength(1);
    now += 1;
    expect(await relays.load()).toHaveLength(1);
    expect(a.calls).toHaveLength(2);
  });

  it('asks once for connections made while the answer is on its way', async () => {
    const a = api(METERED);
    const relays = new RelayList(URL, a.get);
    const [x, y] = await Promise.all([iceServers(relays), iceServers(relays)]);
    expect(x).toEqual(y);
    expect(a.calls).toHaveLength(1);
  });

  it('a failed request gives STUN only, and is not kept: the next connection asks again', async () => {
    for (const failure of [new TypeError('Failed to fetch'), json({ error: 'bad key' }, 401), json({ nothing: true }), new Response('<html>', { status: 200 })]) {
      const a = api(failure, METERED);
      const relays = new RelayList(URL, a.get);
      expect(await iceServers(relays)).toHaveLength(1);
      const list = await iceServers(relays);
      expect(a.calls).toHaveLength(2);
      expect(list).toHaveLength(1 + METERED.length);
    }
  });

  it('gives up on an API that does not answer within 2.5 s (not kept either)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const get = (_url: string, init: RequestInit) => {
      calls++;
      if (calls > 1) return Promise.resolve(json(METERED));
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    };
    const relays = new RelayList(URL, get);
    const first = iceServers(relays);
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS - 1);
    let settled = false;
    void first.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toHaveLength(1);
    expect(await iceServers(relays)).toHaveLength(1 + METERED.length);
    expect(calls).toBe(2);
  });

  it('reads only well-formed servers', () => {
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers({ iceServers: 'turn:x' })).toEqual([]);
    expect(parseIceServers([{ urls: ['turn:a', 7] }, { urls: 5 }, null, { username: 'x' }, { urls: 'stun:b', username: 3 }])).toEqual([
      { urls: ['turn:a'] },
      { urls: ['stun:b'] },
    ]);
  });
});
