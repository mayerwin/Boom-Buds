// The servers a network connection tries: public STUN, then the TURN relays of a credentials API, and the check
// that tells the Network Game screen whether those relays work (src/net/mesh.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RelayList,
  checkRelays,
  iceServers,
  parseIceServers,
  probeRelays,
  relayStatus,
  RELAY_CHECK_MS,
  RELAY_GIVE_UP_MS,
  RELAY_TTL_MS,
  RELAY_TIMEOUT_MS,
  type RelayStatus,
} from '../src/net/mesh.ts';

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it('a connection waits 2.5 s at most for the API; a later answer serves the next connections', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const get = () => {
      calls++;
      return new Promise<Response>((res) => setTimeout(() => res(json(METERED)), 4000));
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
    await vi.advanceTimersByTimeAsync(4000 - RELAY_TIMEOUT_MS);
    expect(await iceServers(relays)).toHaveLength(1 + METERED.length);
    expect(calls).toBe(1);
  });

  it('an API that does not answer within 10 s is given up, and that is not kept', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const get = (_url: string, init: RequestInit) => {
      calls++;
      if (calls > 1) return Promise.resolve(json(METERED));
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    };
    const relays = new RelayList(URL, get);
    const first = iceServers(relays);
    await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS);
    expect(await first).toHaveLength(1);
    // (a connection meanwhile waits for the same request)
    const second = iceServers(relays);
    await vi.advanceTimersByTimeAsync(RELAY_GIVE_UP_MS - RELAY_TIMEOUT_MS);
    expect(await second).toHaveLength(1);
    expect(calls).toBe(1);
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

/** A relay check that answers `answers` in turn, keeping the lists it was given. */
function prober(...answers: RelayStatus[]) {
  const lists: RTCIceServer[][] = [];
  const probe = async (servers: RTCIceServer[]) => {
    lists.push(servers);
    return answers[Math.min(lists.length, answers.length) - 1];
  };
  return { probe, lists };
}

describe('relay check (the note on the Network Game screen)', () => {
  it('without a credentials API there is nothing to check', async () => {
    expect(await checkRelays()).toBe('none');
    expect(relayStatus()).toBe('none');
  });

  it('relays that give an address are ok, and are not checked again while the list is kept', async () => {
    let now = 0;
    const a = api(METERED, METERED);
    const p = prober('ok');
    const relays = new RelayList(URL, a.get, () => now);
    expect(relays.status).toBe('checking');
    expect(await relays.check(p.probe)).toBe('ok');
    expect(relays.status).toBe('ok');
    expect(p.lists[0]).toHaveLength(METERED.length);
    expect(await relays.check(p.probe)).toBe('ok');
    expect(p.lists).toHaveLength(1);
    now += RELAY_TTL_MS;
    expect(await relays.check(p.probe)).toBe('ok');
    expect(a.calls).toHaveLength(2);
    expect(p.lists).toHaveLength(2);
  });

  it('checks made while one is under way share it', async () => {
    const a = api(METERED);
    const p = prober('ok');
    const relays = new RelayList(URL, a.get);
    expect(await Promise.all([relays.check(p.probe), relays.check(p.probe)])).toEqual(['ok', 'ok']);
    expect(a.calls).toHaveLength(1);
    expect(p.lists).toHaveLength(1);
  });

  it('an API refusing for its allowance (402, 429): limit; any other failure: unavailable', async () => {
    const cases: [unknown, RelayStatus][] = [
      [json({ error: 'quota' }, 402), 'limit'],
      [json({ error: 'slow down' }, 429), 'limit'],
      [json({ error: 'bad key' }, 401), 'unavailable'],
      [json({ error: 'oops' }, 500), 'unavailable'],
      [new TypeError('Failed to fetch'), 'unavailable'],
      [[], 'unavailable'],
    ];
    for (const [answer, status] of cases) {
      const p = prober('ok');
      const relays = new RelayList(URL, api(answer).get);
      expect(await relays.check(p.probe)).toBe(status);
      expect(relays.status).toBe(status);
      expect(p.lists).toHaveLength(0);
    }
  });

  it('a failed check is not kept: the next one asks again and finds the relay back', async () => {
    const a = api(json({}, 402), METERED, METERED);
    const p = prober('limit', 'ok');
    const relays = new RelayList(URL, a.get);
    expect(await relays.check(p.probe)).toBe('limit');
    // credentials, but the relay relays nothing (its allowance used up)
    expect(await relays.check(p.probe)).toBe('limit');
    expect(await relays.check(p.probe)).toBe('ok');
    expect(a.calls).toHaveLength(2);
    expect(p.lists).toHaveLength(2);
    // connections get the relays all along
    expect(await iceServers(relays)).toHaveLength(1 + METERED.length);
  });

  it('a check waits for a slow API (a connection would have given up on it)', async () => {
    vi.useFakeTimers();
    const get = () => new Promise<Response>((res) => setTimeout(() => res(json(METERED)), 6000));
    const p = prober('ok');
    const relays = new RelayList(URL, get);
    const status = relays.check(p.probe);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await status).toBe('ok');
  });

  it('a check that throws counts as unavailable', async () => {
    const relays = new RelayList(URL, api(METERED).get);
    expect(await relays.check(() => Promise.reject(new Error('no WebRTC')))).toBe('unavailable');
  });
});

/** A stand-in RTCPeerConnection whose ICE gathering gives `events`: a candidate type, a TURN error code, or null (the end). */
function fakePeerConnection(events: (string | number | null)[]) {
  const made: { config: RTCConfiguration; closed: boolean }[] = [];
  class FakePC {
    onicecandidate: ((e: { candidate: { type: string; candidate: string } | null }) => void) | null = null;
    onicecandidateerror: ((e: { errorCode: number }) => void) | null = null;
    private me: { config: RTCConfiguration; closed: boolean };
    constructor(config: RTCConfiguration) {
      this.me = { config, closed: false };
      made.push(this.me);
    }
    createDataChannel() {
      return {};
    }
    async createOffer() {
      return { type: 'offer', sdp: '' };
    }
    async setLocalDescription() {
      for (const e of events) {
        await Promise.resolve();
        if (typeof e === 'number') this.onicecandidateerror?.({ errorCode: e });
        else this.onicecandidate?.({ candidate: e === null ? null : { type: e, candidate: `candidate:1 1 udp 1 203.0.113.9 50000 typ ${e}` } });
      }
    }
    close() {
      this.me.closed = true;
    }
  }
  vi.stubGlobal('RTCPeerConnection', FakePC);
  return made;
}

describe('relay probe (one relayed address asked for)', () => {
  it('a relayed address: ok; only the TURN servers are asked, for relayed paths, and the connection is closed', async () => {
    const made = fakePeerConnection(['relay']);
    expect(await probeRelays(METERED)).toBe('ok');
    expect(made).toHaveLength(1);
    expect(made[0].config.iceTransportPolicy).toBe('relay');
    expect(urls(made[0].config.iceServers!)).toEqual(METERED.slice(1).map((s) => s.urls));
    expect(made[0].closed).toBe(true);
  });

  it('refused for its allowance (486, Allocation Quota Reached): limit', async () => {
    fakePeerConnection([486, 486, null]);
    expect(await probeRelays(METERED)).toBe('limit');
  });

  it('out of reach, or refused otherwise: unavailable', async () => {
    fakePeerConnection([701, 401, null]);
    expect(await probeRelays(METERED)).toBe('unavailable');
  });

  it('no TURN server in the list: unavailable, without asking', async () => {
    const made = fakePeerConnection(['relay']);
    expect(await probeRelays([METERED[0]])).toBe('unavailable');
    expect(made).toHaveLength(0);
  });

  it('gives up after 5 s without an address', async () => {
    vi.useFakeTimers();
    const made = fakePeerConnection([]);
    const r = probeRelays(METERED);
    await vi.advanceTimersByTimeAsync(RELAY_CHECK_MS);
    expect(await r).toBe('unavailable');
    expect(made[0].closed).toBe(true);
  });
});
