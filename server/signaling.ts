// Local message relay for the room signaling (src/net/relay.ts, LocalRelay): a tiny publish/subscribe
// service on the WebSocket path /signal of the Vite dev server and of the LAN server. It stands in for the
// public MQTT brokers in tests and at LAN parties without internet (open the game with ?relay=local).
// Messages: client -> {type:'sub'|'unsub', topic} | {type:'pub', topic, data}; server -> {type:'msg', topic, data}.

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

const topics = new Map<string, Set<WebSocket>>();

function unsubscribeAll(ws: WebSocket): void {
  for (const [t, set] of topics) {
    set.delete(ws);
    if (!set.size) topics.delete(t);
  }
}

function onMessage(ws: WebSocket, raw: string): void {
  let m: { type?: string; topic?: unknown; data?: unknown };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  const topic = typeof m.topic === 'string' ? m.topic.slice(0, 200) : '';
  if (!topic) return;
  if (m.type === 'sub') {
    let set = topics.get(topic);
    if (!set) {
      set = new Set();
      topics.set(topic, set);
    }
    set.add(ws);
  } else if (m.type === 'unsub') {
    topics.get(topic)?.delete(ws);
  } else if (m.type === 'pub' && typeof m.data === 'string' && m.data.length < 65536) {
    const out = JSON.stringify({ type: 'msg', topic, data: m.data });
    for (const peer of topics.get(topic) ?? []) if (peer.readyState === peer.OPEN) peer.send(out);
  }
}

/**
 * Accept relay WebSocket connections on `path` of an existing HTTP server. Other upgrade requests
 * (e.g. Vite's hot reload socket) are left to their own handlers.
 */
export function attachSignaling(server: Server, path = '/signal'): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    if (pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data) => onMessage(ws, data.toString()));
    ws.on('close', () => unsubscribeAll(ws));
  });
  return wss;
}
