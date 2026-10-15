// Read-only animation database shared by the simulation and the renderer: sequence name ->
// states -> frame references (atlas frame index plus the per-state x/y offsets stored in the ANI).

export interface SeqFrameRef {
  frame: number;
  dx: number;
  dy: number;
}

export class AnimDB {
  private index = new Map<string, number>();
  /** seq -> state -> refs */
  readonly seqs: SeqFrameRef[][][] = [];
  readonly names: string[] = [];

  constructor(seqs: Record<string, [number, number, number][][]>) {
    for (const [name, states] of Object.entries(seqs)) {
      this.index.set(name, this.seqs.length);
      this.names.push(name);
      this.seqs.push(states.map((st) => st.map(([frame, dx, dy]) => ({ frame, dx, dy }))));
    }
  }

  /** Sequence number for a name (like ani_find_seq), or -1. */
  find(name: string): number {
    return this.index.get(name) ?? -1;
  }

  get(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`unable to find sequence '${name}'`);
    return i;
  }

  states(seq: number): number {
    return this.seqs[seq].length;
  }

  /** First frame reference of a state (ani_seqno_to_frameno + offsets). */
  ref(seq: number, state: number): SeqFrameRef {
    const st = this.seqs[seq];
    return st[state][0];
  }
}
