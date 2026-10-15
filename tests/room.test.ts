// Room signaling over a relay: codes, joining, refusals, message relay, leaving; and the MQTT packet codec.
import { describe, it, expect } from 'vitest';
import { RoomSignaling, normalizeRoomCode, newRoomCode, roomTopic, CODE_ALPHABET } from '../src/net/room.ts';
import { MemoryRelay } from '../src/net/relay.ts';
import { mqttPacket, mqttParse } from '../src/net/mqtt.ts';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('room codes', () => {
  it('are 6 symbols from an alphabet without look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      const c = newRoomCode();
      expect(c).toMatch(/^[A-Z0-9]{6}$/);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
      expect(normalizeRoomCode(c.toLowerCase())).toBe(c);
    }
    for (const ch of '0O1IL') expect(CODE_ALPHABET).not.toContain(ch);
    expect(normalizeRoomCode(' ab-c 3x2 ')).toBe('ABC3X2');
    expect(normalizeRoomCode('ABC1O2')).toBeNull();
    expect(normalizeRoomCode('ABC12')).toBeNull();
    expect(normalizeRoomCode('ABC12$')).toBeNull();
    expect(roomTopic('ABC123')).toBe(roomTopic('ABC123'));
    expect(roomTopic('ABC123')).not.toBe(roomTopic('ABC124'));
  });
});

describe('room signaling', () => {
  it('lets machines join the host and relays signaling data between them', async () => {
    const host = new RoomSignaling(new MemoryRelay(), 'Host');
    const code = await host.create();
    const joined: number[] = [];
    host.on('peer-joined', (m) => joined.push((m.peer as { id: number }).id));
    const a = new RoomSignaling(new MemoryRelay(), 'Anna');
    const ra = await a.join(code);
    expect(ra.ok).toBe(true);
    if (!ra.ok) return;
    expect(ra.hostId).toBe(host.id);
    expect(ra.peers.map((p) => p.name)).toEqual(['Host']);
    expect(joined).toEqual([a.id]);
    // the second machine learns about both
    const b = new RoomSignaling(new MemoryRelay(), 'Bert');
    const rb = await b.join(code);
    expect(rb.ok && rb.peers.map((p) => p.name).sort()).toEqual(['Anna', 'Host']);
    // signaling data reaches only its addressee, with the sender's name known
    const got: unknown[] = [];
    host.on('signal', (m) => got.push(['host', m.data]));
    a.on('signal', (m) => got.push(['anna', m.data]));
    b.signal(a.id, { sdp: 'offer' });
    await settle();
    expect(got).toEqual([['anna', { sdp: 'offer' }]]);
    expect(a.names.get(b.id)).toBe('Bert');
    // leaving
    const left: number[] = [];
    let closed = false;
    a.on('peer-left', (m) => left.push(Number(m.peer)));
    a.on('room-closed', () => (closed = true));
    b.leave();
    await settle();
    expect(left).toEqual([b.id]);
    host.leave();
    await settle();
    expect(closed).toBe(true);
    for (const r of [host, a, b]) r.close();
  });

  it('refuses unknown codes, closed rooms, full rooms and other versions', async () => {
    const lonely = new RoomSignaling(new MemoryRelay(), 'X');
    expect(await lonely.join('ZZZZZZ', 400)).toEqual({ ok: false, reason: 'not-found' });

    const host = new RoomSignaling(new MemoryRelay(), 'Host');
    const code = await host.create();
    host.open = false;
    const a = new RoomSignaling(new MemoryRelay(), 'A');
    expect(await a.join(code, 2000)).toEqual({ ok: false, reason: 'started' });
    host.open = true;
    host.memberCount = () => 10;
    expect(await a.join(code, 2000)).toEqual({ ok: false, reason: 'full' });
    host.memberCount = () => 1;
    expect((await a.join(code, 2000)).ok).toBe(true);
    // the room is full now: the next machine is refused
    host.memberCount = () => 10;
    const b = new RoomSignaling(new MemoryRelay(), 'B');
    expect(await b.join(code, 2000)).toEqual({ ok: false, reason: 'full' });
    for (const r of [host, a, b, lonely]) r.close();
  });

  it('does not mix up rooms', async () => {
    const h1 = new RoomSignaling(new MemoryRelay(), 'H1');
    const h2 = new RoomSignaling(new MemoryRelay(), 'H2');
    const c1 = await h1.create();
    const c2 = await h2.create();
    const a = new RoomSignaling(new MemoryRelay(), 'A');
    const r = await a.join(c2);
    expect(r.ok && r.hostId).toBe(h2.id);
    expect(c1).not.toBe(c2);
    for (const x of [h1, h2, a]) x.close();
  });
});

describe('MQTT codec', () => {
  it('encodes lengths and splits a byte stream into packets', () => {
    const small = mqttPacket(3, 0, [1, 2, 3]);
    expect(Array.from(small)).toEqual([0x30, 3, 1, 2, 3]);
    const big = mqttPacket(3, 0, new Uint8Array(200));
    expect(Array.from(big.subarray(0, 3))).toEqual([0x30, 200 & 127 | 128, 1]);
    const stream = new Uint8Array([...small, ...big, 0xd0]);
    const seen: [number, number][] = [];
    const rest = mqttParse(stream, (type, _f, body) => seen.push([type, body.length]));
    expect(seen).toEqual([[3, 3], [3, 200]]);
    expect(Array.from(rest)).toEqual([0xd0]);
  });
});
