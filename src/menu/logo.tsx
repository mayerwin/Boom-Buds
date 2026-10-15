// The Boom Buds logo, drawn in SVG: chunky letters with a fiery gradient and a dark outline, the two O's of
// BOOM being cartoon bombs whose fuses spark. The picture is static (painted once, shadow included); the two
// sparks are separate HTML layers over it, so that their animation runs on the compositor.

import type { JSX } from 'preact';

const VIEW_W = 520, VIEW_H = 300;
const BOMB_R = 54;
const BOMBS = [163, 281].map((x) => {
  const y = 100, r = BOMB_R;
  // fuse from the cap (upper right) curling up to the spark
  const cx = x + r * 0.62, cy = y - r * 0.66;
  return { x, y, cx, cy, sx: cx + r * 0.84, sy: cy - r * 0.66 };
});

function Bomb(props: { x: number; y: number; cx: number; cy: number }): JSX.Element {
  const { x, y, cx, cy } = props;
  const r = BOMB_R;
  const fuse = `M ${cx} ${cy} q ${r * 0.22} ${-r * 0.32} ${r * 0.5} ${-r * 0.24} t ${r * 0.34} ${-r * 0.42}`;
  return (
    <g>
      <path d={fuse} fill="none" stroke="#2b0f45" stroke-width={r * 0.2} stroke-linecap="round" />
      <path d={fuse} fill="none" stroke="#e9c48a" stroke-width={r * 0.09} stroke-linecap="round" />
      <circle cx={x} cy={y} r={r} fill="#2b0f45" />
      <circle cx={x} cy={y} r={r * 0.9} fill="url(#bb-bomb)" />
      <ellipse cx={x - r * 0.32} cy={y - r * 0.36} rx={r * 0.28} ry={r * 0.18} transform={`rotate(-35 ${x - r * 0.32} ${y - r * 0.36})`} fill="#fff" opacity="0.55" />
      <circle cx={x - r * 0.12} cy={y - r * 0.55} r={r * 0.06} fill="#fff" opacity="0.7" />
      <rect x={cx - r * 0.2} y={cy - r * 0.14} width={r * 0.4} height={r * 0.28} rx={r * 0.08} transform={`rotate(40 ${cx} ${cy})`} fill="#6b6f8f" stroke="#2b0f45" stroke-width={r * 0.07} />
    </g>
  );
}

/** One fuse spark: a glow and a four-pointed star, in a box of 2 x SPARK units around its centre. */
const SPARK = BOMB_R * 0.34;
function Spark(props: { sx: number; sy: number; delay: number }): JSX.Element {
  const s = SPARK;
  return (
    <span
      class="bb-spark"
      aria-hidden="true"
      style={{
        left: `${((props.sx - s) / VIEW_W) * 100}%`,
        top: `${((props.sy - s) / VIEW_H) * 100}%`,
        width: `${((2 * s) / VIEW_W) * 100}%`,
        animationDelay: `${props.delay}s`,
      }}
    >
      <svg viewBox="-1 -1 2 2">
        <defs>
          <radialGradient id={`bb-glow-${props.delay}`}>
            <stop offset="0" stop-color="#ffffff" stop-opacity="1" />
            <stop offset="0.35" stop-color="#ffd23f" stop-opacity="0.9" />
            <stop offset="1" stop-color="#ff7a1f" stop-opacity="0" />
          </radialGradient>
        </defs>
        <circle r="0.94" fill={`url(#bb-glow-${props.delay})`} />
        <path d="M 0 -0.88 L 0.24 -0.24 L 0.88 0 L 0.24 0.24 L 0 0.88 L -0.24 0.24 L -0.88 0 L -0.24 -0.24 Z" fill="#fff6c8" />
      </svg>
    </span>
  );
}

export function Logo(props: { class?: string }): JSX.Element {
  const letter = { 'font-family': "'Lilita One', system-ui", 'font-size': 150, fill: 'url(#bb-fill)', stroke: '#2b0f45', 'stroke-width': 16, 'paint-order': 'stroke', 'stroke-linejoin': 'round' } as const;
  return (
    <div class={`bb-logo ${props.class ?? ''}`} role="img" aria-label="Boom Buds">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} aria-hidden="true">
        <defs>
          <linearGradient id="bb-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#fff59a" />
            <stop offset="0.42" stop-color="#ffc233" />
            <stop offset="0.75" stop-color="#ff8a2a" />
            <stop offset="1" stop-color="#ff4f86" />
          </linearGradient>
          <radialGradient id="bb-bomb" cx="0.35" cy="0.32" r="0.8">
            <stop offset="0" stop-color="#6c7194" />
            <stop offset="0.45" stop-color="#2a2d45" />
            <stop offset="1" stop-color="#0c0d18" />
          </radialGradient>
        </defs>
        <text x="16" y="150" {...letter}>B</text>
        {BOMBS.map((b) => <Bomb {...b} />)}
        <text x="344" y="150" {...letter}>M</text>
        <text x="260" y="282" text-anchor="middle" {...letter} font-size="136" letter-spacing="2">BUDS</text>
      </svg>
      {BOMBS.map((b, i) => <Spark sx={b.sx} sy={b.sy} delay={i * 0.45} />)}
    </div>
  );
}
