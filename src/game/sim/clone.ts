// Fast deep copy of the plain-data simulation state (rollback snapshots are taken every tick in network
// games; this is about 10x faster than structuredClone for GameState).

export function cloneState<T>(v: T): T {
  if (Array.isArray(v)) {
    const n = v.length;
    if (n > 0 && typeof v[0] === 'number') return v.slice() as T;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = cloneState(v[i]);
    return out as T;
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k in v) out[k] = cloneState((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}
