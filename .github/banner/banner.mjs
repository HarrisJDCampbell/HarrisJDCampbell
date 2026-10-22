#!/usr/bin/env node
// Writes banner.svg: a basketball bounces across the name, lighting each
// letter gold as it lands, then arcs into a hoop and the whole name flashes.
// Static output, so it's generated once and committed rather than run in CI.
//
//   node .github/banner/banner.mjs [--out banner.svg]

import { writeFileSync } from 'node:fs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : 'banner.svg';

const NAME = 'Harris Campbell';
const SUBTITLE = 'cs @ sfsu · founder of visbets · H.O.R.S.E legend';

const W = 900, H = 210;
const FONT = 60, ADV = FONT * 0.62;        // one fixed slot per letter
const BASE = 118;                          // baseline of the name
const CAP = FONT * 0.73, XH = FONT * 0.55; // cap height and x-height, roughly
const TALL = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZbdfhiklt');
const R = 7;                               // ball radius
const RIM = { x1: 812, x2: 842, y: 92 };
const RIM_CX = (RIM.x1 + RIM.x2) / 2;

const C = {
  dim: '#484f58', lit: '#e6edf3', gold: '#ffc72c', sub: '#7d8590',
  ball: '#f0883e', seam: '#7c3a10', line: '#388bfd', rim: '#f85149', net: '#8b949e',
};

const HOP = 0.32, SPACE_HOP = 0.5, ENTRY = 0.6, SHOT = 0.8, HOLD = 3.2, FADE = 0.6, EPS = 0.01;

// ---------- timeline ----------

const startX = W / 2 - (NAME.length * ADV) / 2;
const letters = [...NAME].map((ch, i) => ({
  ch, x: startX + (i + 0.5) * ADV, top: BASE - (TALL.has(ch) ? CAP : XH),
})).filter((l) => l.ch !== ' ');

const ballPath = []; // [t, x, y]
const hopArc = (from, to, t0, dur, lift) => {
  const apex = Math.min(from[1], to[1]) - lift;
  const cy = 2 * apex - (from[1] + to[1]) / 2;
  for (let k = 1; k <= 10; k++) {
    const s = k / 10, u = 1 - s;
    ballPath.push([t0 + s * dur, from[0] + (to[0] - from[0]) * s, u * u * from[1] + 2 * u * s * cy + s * s * to[1]]);
  }
};

let t = 0.3;
let pos = [-20, 30];
ballPath.push([0, ...pos], [t, ...pos]);
letters.forEach((l, i) => {
  const land = [l.x, l.top - R - 2];
  const wordGap = i > 0 && l.x - letters[i - 1].x > ADV * 1.5;
  const dur = i === 0 ? ENTRY : wordGap ? SPACE_HOP : HOP;
  hopArc(pos, land, t, dur, wordGap ? 46 : 26);
  t += dur;
  l.land = t;
  pos = land;
});
hopArc(pos, [RIM_CX, RIM.y - 3], t, SHOT, 60);
const swish = t + SHOT;
ballPath.push([swish + 0.15, RIM_CX, RIM.y + 18], [swish + 0.45, RIM_CX, RIM.y + 60]);
const end = swish + HOLD;
const T = end + FADE;

// ---------- css ----------

const pct = (x) => `${((Math.min(T, Math.max(0, x)) / T) * 100).toFixed(3)}%`;
const kf = (name, frames) => `@keyframes ${name}{${[...frames].sort((a, b) => a[0] - b[0]).map(([x, css]) => `${pct(x)}{${css}}`).join('')}}`;
const loop = (name) => `.${name}{animation:${name} ${T.toFixed(2)}s linear infinite}`;
const css = [];
const els = [];

// Letters: dim until the ball lands, a gold flash, then lit. The whole name
// flashes gold again on the swish and dims back down when the loop resets.
letters.forEach((l, i) => {
  css.push(kf(`l${i}`, [
    [0, `fill:${C.dim};transform:translateY(0)`],
    [l.land - EPS, `fill:${C.dim};transform:translateY(0)`],
    [l.land, `fill:${C.gold};transform:translateY(3px)`],
    [l.land + 0.12, `fill:${C.gold};transform:translateY(0)`],
    [l.land + 0.45, `fill:${C.lit};transform:translateY(0)`],
    [swish + 0.05, `fill:${C.lit};transform:translateY(0)`],
    [swish + 0.15, `fill:${C.gold};transform:translateY(0)`],
    [swish + 0.9, `fill:${C.lit};transform:translateY(0)`],
    [end, `fill:${C.lit};transform:translateY(0)`],
    [T, `fill:${C.dim};transform:translateY(0)`],
  ]), loop(`l${i}`));
  els.push(`<text class="l${i}" x="${l.x.toFixed(1)}" y="${BASE}" text-anchor="middle" font-size="${FONT}" font-weight="800" fill="${C.dim}">${l.ch}</text>`);
});

// Ball: follows the path, spins as it flies, and fades after dropping through the net.
const hiddenAt = ballPath.at(-1);
css.push(kf('ball', [
  [0, `transform:translate(${ballPath[0][1]}px,${ballPath[0][2]}px);opacity:0`],
  ...ballPath.map(([x, bx, by], k) => [x, `transform:translate(${bx.toFixed(1)}px,${by.toFixed(1)}px);opacity:${k === 0 ? 0 : 1}`]),
  [hiddenAt[0] + 0.15, `transform:translate(${hiddenAt[1]}px,${hiddenAt[2]}px);opacity:0`],
  [T, `transform:translate(${hiddenAt[1]}px,${hiddenAt[2]}px);opacity:0`],
]), loop('ball'));
css.push('@keyframes spin{to{transform:rotate(360deg)}}.spin{animation:spin .9s linear infinite;transform-box:fill-box;transform-origin:center}');
els.push(`<g class="ball"><g class="spin"><circle r="${R}" fill="${C.ball}"/>` +
  `<path d="M-${R} 0H${R}M0 -${R}V${R}M-4.9 -4.9Q0 0 -4.9 4.9M4.9 -4.9Q0 0 4.9 4.9" stroke="${C.seam}" stroke-width="1" fill="none"/></g></g>`);

// Hoop, with the net flicking on the swish. The rim is drawn after the ball
// so the ball passes behind its front edge.
css.push(kf('net', [[0, 'transform:scaleY(1)'], [swish, 'transform:scaleY(1)'], [swish + 0.1, 'transform:scaleY(1.4)'], [swish + 0.35, 'transform:scaleY(1)'], [T, 'transform:scaleY(1)']]));
css.push(`.net{animation:net ${T.toFixed(2)}s linear infinite;transform-box:fill-box;transform-origin:50% 0}`);
const hoop = `<rect x="${RIM.x2 + 2}.5" y="${RIM.y - 34}.5" width="4" height="40" fill="#0d1117" stroke="${C.net}"/>` +
  `<g class="net" stroke="${C.net}" stroke-width="1" fill="none"><path d="M${RIM.x1} ${RIM.y + 1}L${RIM.x1 + 6} ${RIM.y + 18}L${RIM.x2 - 6} ${RIM.y + 18}L${RIM.x2} ${RIM.y + 1}M${RIM.x1 + 8} ${RIM.y + 1}L${RIM.x1 + 10} ${RIM.y + 18}M${RIM.x2 - 8} ${RIM.y + 1}L${RIM.x2 - 10} ${RIM.y + 18}M${RIM.x1 + 3} ${RIM.y + 9}L${RIM.x2 - 3} ${RIM.y + 9}"/></g>`;
const rim = `<line x1="${RIM.x1}" y1="${RIM.y}" x2="${RIM.x2 + 2}" y2="${RIM.y}" stroke="${C.rim}" stroke-width="3" stroke-linecap="round"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
<title>Harris Campbell</title>
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d1117"/><stop offset=".45" stop-color="#0d2a1a"/><stop offset=".7" stop-color="#0a1628"/><stop offset="1" stop-color="#0d1117"/></linearGradient></defs>
<style>${css.join('')}</style>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14" fill="url(#bg)" stroke="${C.line}" stroke-opacity=".35"/>
<g stroke="${C.line}" stroke-opacity=".12" fill="none"><line x1="${W / 2}" y1="1" x2="${W / 2}" y2="${H - 1}"/><circle cx="${W / 2}" cy="${H / 2}" r="62"/><circle cx="${W / 2}" cy="${H / 2}" r="14"/></g>
${hoop}${els.join('')}${rim}
<text x="${W / 2}" y="${BASE + 44}" text-anchor="middle" font-size="16" fill="${C.sub}">${SUBTITLE}</text>
</svg>
`;

writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (loop ${T.toFixed(1)}s)`);
