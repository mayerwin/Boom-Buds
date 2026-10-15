// Minimal MQTT 3.1.1 client over WebSocket: QoS 0 publish / subscribe and keep-alive. That is all the
// room signaling needs from the public brokers (src/net/relay.ts); game data never goes through them.

const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8(s: string): number[] {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}

/** One MQTT control packet: fixed header (type, flags, remaining length) and body. */
export function mqttPacket(type: number, flags: number, body: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const len: number[] = [];
  let n = body.length;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    len.push(d);
  } while (n > 0);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = (type << 4) | flags;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** Split a byte stream into packets; returns the bytes of an incomplete trailing packet. */
export function mqttParse(buf: Uint8Array, handle: (type: number, flags: number, body: Uint8Array) => void): Uint8Array {
  let pos = 0;
  for (;;) {
    if (buf.length - pos < 2) break;
    let len = 0;
    let mul = 1;
    let i = pos + 1;
    let complete = false;
    while (i < buf.length && i < pos + 5) {
      const d = buf[i++];
      len += (d & 127) * mul;
      mul *= 128;
      if (!(d & 128)) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      if (i >= pos + 5) throw new Error('malformed MQTT length');
      break;
    }
    if (buf.length < i + len) break;
    handle(buf[pos] >> 4, buf[pos] & 15, buf.subarray(i, i + len));
    pos = i + len;
  }
  return buf.slice(pos);
}

export class MqttClient {
  readonly url: string;
  connected = false;
  onMessage: (topic: string, payload: Uint8Array) => void = () => {};
  /** the connection dropped after it had been established */
  onClose: () => void = () => {};
  private ws: WebSocket | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private packetId = 1;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(clientId: string, timeoutMs = 8000): Promise<void> {
    this.closing = false;
    this.buf = new Uint8Array(0);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.url}: ${why}`));
        }
        this.close();
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, ['mqtt']);
      } catch (e) {
        fail(String(e));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      // CONNECT: protocol "MQTT" level 4, clean session, keep-alive 30 s
      ws.onopen = () => ws.send(mqttPacket(1, 0, [...utf8('MQTT'), 4, 0x02, 0, 30, ...utf8(clientId)]));
      ws.onerror = () => fail('connection error');
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.keepAlive = null;
        if (!settled) fail('closed');
        else if (was && !this.closing) this.onClose();
      };
      ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        const all = new Uint8Array(this.buf.length + data.length);
        all.set(this.buf);
        all.set(data, this.buf.length);
        try {
          this.buf = mqttParse(all, (type, flags, body) => {
            if (type === 2) {
              // CONNACK
              if (body[1] !== 0) {
                fail(`refused (${body[1]})`);
                return;
              }
              this.connected = true;
              settled = true;
              clearTimeout(timer);
              this.keepAlive = setInterval(() => this.send(mqttPacket(12, 0, [])), 20_000);
              resolve();
            } else if (type === 3) {
              // PUBLISH
              const tl = (body[0] << 8) | body[1];
              const topic = dec.decode(body.subarray(2, 2 + tl));
              let p = 2 + tl;
              if ((flags >> 1) & 3) p += 2; // packet identifier (QoS > 0)
              this.onMessage(topic, body.slice(p));
            }
            // SUBACK, UNSUBACK, PINGRESP: nothing to do
          });
        } catch {
          this.close();
        }
      };
    });
  }

  private send(p: Uint8Array<ArrayBuffer>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(p);
  }

  private nextId(): number[] {
    const id = this.packetId;
    this.packetId = (this.packetId % 65535) + 1;
    return [id >> 8, id & 255];
  }

  subscribe(topic: string): void {
    this.send(mqttPacket(8, 2, [...this.nextId(), ...utf8(topic), 0]));
  }

  unsubscribe(topic: string): void {
    this.send(mqttPacket(10, 2, [...this.nextId(), ...utf8(topic)]));
  }

  publish(topic: string, payload: Uint8Array): void {
    const t = utf8(topic);
    const body = new Uint8Array(t.length + payload.length);
    body.set(t);
    body.set(payload, t.length);
    this.send(mqttPacket(3, 0, body));
  }

  close(): void {
    this.closing = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(mqttPacket(14, 0, [])); // DISCONNECT
      } catch {
        // closing anyway
      }
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}
