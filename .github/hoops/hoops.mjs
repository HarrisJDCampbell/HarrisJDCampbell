#!/usr/bin/env node
// Turns a GitHub contribution calendar into an animated basketball court.
// A player dribbles under the grid week by week and takes one shot for every
// day that has contributions. The day's square becomes the ball, every shot
// goes in, and the bucket is worth that day's contribution count. He finishes
// with a dunk. Writes a light and a dark SVG. No dependencies; Node 18+.
//
//   GITHUB_TOKEN=... node hoops.mjs [--user NAME] [--out DIR] [--fixture FILE]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- input ----------

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const USER = args.user ?? process.env.HOOPS_USER ?? 'HarrisJDCampbell';
const OUT = args.out ?? 'dist';

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

async function fetchCalendar(login, token) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const query = `query($login: String!) { user(login: $login) { contributionsCollection {
    contributionCalendar { totalContributions weeks { contributionDays {
      contributionCount contributionLevel date weekday } } } } } }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'hoops' },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL returned ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data.user.contributionsCollection.contributionCalendar;
}

// ---------- layout ----------

const W = 900, H = 218;
const CELL = 11, STEP = 13, GX = 16, GY = 30; // contribution grid
const FY = 200;                                // floor line
const RIM = { x1: 832, x2: 860, y: 128 };      // rim, in front of the backboard
const RIM_CX = (RIM.x1 + RIM.x2) / 2;
const BALL_R = 4;
const SCALE = 1.35;                            // sprite is drawn in pixel units, then scaled
const HAND_Y = 36 * SCALE;                     // ball height above the feet when shooting

const colX = (i) => GX + i * STEP + CELL / 2;
const cellY = (weekday) => GY + weekday * STEP;

const PALETTES = {
  light: {
    cells: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    floor: '#d0d7de', text: '#57606a', strong: '#24292f', gold: '#b7791f',
    board: '#ffffff', boardLine: '#8c959f', rim: '#cf222e', net: '#8c959f', pole: '#6e7781',
  },
  dark: {
    cells: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
    floor: '#30363d', text: '#7d8590', strong: '#e6edf3', gold: '#ffc72c',
    board: '#0d1117', boardLine: '#8b949e', rim: '#f85149', net: '#8b949e', pole: '#6e7681',
  },
};
// Royal blue and gold.
const PLAYER = { skin: '#c68b59', hair: '#2b1d14', blue: '#1d428a', gold: '#ffc72c', shoes: '#f0f6fc' };
const BALL = { fill: '#f0883e', seam: '#7c3a10' };

// ---------- timeline ----------
// Everything runs on one clock of length T seconds. Each animated element gets
// its own @keyframes built from [time, css] pairs on that clock.

// A relaxed shootaround: for each active day he walks to its column, reaches
// up and the bubble floats down into his hands, dribbles it for a few beats
// while taking a step, shoots, and watches it drop before the next one.
const WALK = 0.3;     // seconds per column of walking
const GRAB = 0.55;    // bubble floating down into his hands
const DRIBBLE = 1.1;  // dribbling before the shot
const STEP_IN = 10;   // pixels he steps toward the hoop while dribbling
const RISE = 0.18;    // gather to release
const LAND = 0.35;    // gather to landing
const WATCH = 0.7;    // watching the ball before going for the next bubble
const FADE = 0.8;     // reset fade at the end of the loop
const HOLD = 3;       // pause after the dunk
const EPS = 0.01;     // gap used to make a value change look instant

// Longer shots hang in the air longer.
const flightTime = (dist) => 1.0 + Math.min(1, dist / 800) * 0.7;

function buildTimeline(weeks) {
  const player = [];   // [t, x, y]
  const walking = [];  // [start, end] windows where he is moving along the floor
  const armsUp = [];   // [start, end] windows with his arms raised
  const holding = [];  // { from, to, level } windows where he is dribbling a bubble
  const shots = [];    // { grab, caught, release, flight, swish, x, y, grabX, day, count }
  const scores = [];   // [t, cumulative score]

  let t = 0.6;
  let x = colX(0) - 28;
  player.push([0, x, 0], [t, x, 0]);
  let score = 0;

  const walkTo = (nx) => {
    if (nx === x) return;
    const start = t;
    t += (Math.abs(nx - x) / STEP) * WALK;
    walking.push([start, t]);
    x = nx;
    player.push([t, x, 0]);
  };

  weeks.forEach((week, i) => {
    for (const day of week.contributionDays) {
      if (day.contributionCount === 0) continue;
      walkTo(colX(i));
      const grab = t, caught = t + GRAB;
      armsUp.push([grab, caught]);
      t = caught;
      player.push([t, x, 0]);

      const stepStart = t + DRIBBLE - 0.35;
      t += DRIBBLE;
      walking.push([stepStart, t]);
      player.push([stepStart, x, 0], [t, x + STEP_IN, 0]);
      x += STEP_IN;
      holding.push({ from: caught, to: t, level: LEVELS[day.contributionLevel] ?? 1 });

      const release = t + RISE, land = t + LAND;
      player.push([release, x, -8], [land, x, 0]);
      armsUp.push([t, land]);
      const flight = flightTime(RIM_CX - x);
      const swish = release + flight;
      shots.push({ grab, caught, release, flight, swish, x, y: FY - 8 - HAND_Y, grabX: colX(i), day, count: day.contributionCount });
      scores.push([swish, (score += day.contributionCount)]);
      t = land + WATCH;
      player.push([t, x, 0]);
    }
  });

  // Jog to the hoop and dunk. It's for show: the score is already final.
  const runUp = 806;
  t = Math.max(t, (shots.at(-1)?.swish ?? t) - 0.4);
  player.push([t, x, 0]);
  const jogStart = t;
  walkTo(runUp);
  const takeoff = t + 0.1;
  holding.push({ from: jogStart, to: takeoff, level: 4 });
  const peak = takeoff + 0.35;
  const hangEnd = peak + 0.25;
  const landed = hangEnd + 0.3;
  const dunkX = RIM_CX - 8;
  const peakY = RIM.y - (FY - HAND_Y) - 4; // hands just above the rim
  player.push([takeoff, runUp, 0], [peak, dunkX, peakY], [hangEnd, dunkX, peakY + 6], [landed, dunkX - 6, 0]);
  armsUp.push([takeoff, landed]);

  const end = landed + HOLD;
  const T = end + FADE;
  return { T, end, player, walking, armsUp, holding, shots, dunk: { takeoff, at: peak }, scores, finalScore: score };
}

// ---------- keyframes ----------

function keyframes(name, frames, T) {
  const sorted = [...frames].sort((a, b) => a[0] - b[0]);
  if (sorted[0][0] > 0) sorted.unshift([0, sorted[0][1]]);
  if (sorted.at(-1)[0] < T) sorted.push([T, sorted.at(-1)[1]]);
  const body = sorted
    .map(([t, css]) => `${Math.min(100, Math.max(0, (t / T) * 100)).toFixed(3)}%{${css}}`)
    .join('');
  return `@keyframes ${name}{${body}}`;
}

const tr = (x, y) => `transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;

// Joins windows that touch or overlap, so back-to-back windows don't flicker.
function merge(list) {
  const out = [];
  for (const [a, b] of [...list].sort((p, q) => p[0] - q[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + 2 * EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Opacity that is `on` inside the windows and `off` outside, switching instantly.
function windows(list, T, on = 1, off = 0) {
  const frames = [[0, `opacity:${off}`]];
  for (const [a, b] of merge(list)) {
    frames.push([Math.max(0, a - EPS), `opacity:${off}`], [a, `opacity:${on}`]);
    frames.push([b, `opacity:${on}`], [Math.min(T, b + EPS), `opacity:${off}`]);
  }
  return frames;
}

function quadPoint(p0, c, p1, s) {
  const u = 1 - s;
  return [u * u * p0[0] + 2 * u * s * c[0] + s * s * p1[0], u * u * p0[1] + 2 * u * s * c[1] + s * s * p1[1]];
}

// A quadratic Bezier with its control point halfway across: x moves at a
// constant rate and y follows a parabola, which is what a real shot does.
function arc(from, to, startT, duration, samples = 12) {
  const dist = Math.abs(to[0] - from[0]);
  const apex = Math.max(8, Math.min(from[1], to[1]) - (36 + dist * 0.12));
  const control = [(from[0] + to[0]) / 2, 2 * apex - (from[1] + to[1]) / 2];
  const frames = [];
  for (let k = 0; k <= samples; k++) {
    const s = k / samples;
    const [x, y] = quadPoint(from, control, to, s);
    frames.push([startT + s * duration, `${tr(x, y)};opacity:1`]);
  }
  return frames;
}

const shortDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

// ---------- render ----------

function render(calendar, paletteName) {
  const pal = PALETTES[paletteName];
  const weeks = calendar.weeks;
  const tl = buildTimeline(weeks);
  const { T } = tl;
  const css = [];
  const els = [];
  const anim = (cls, frames, extra = '') => {
    css.push(keyframes(cls, frames, T));
    css.push(`.${cls}{animation:${cls} ${T.toFixed(2)}s linear infinite;${extra}}`);
  };

  // Grid: an empty layer underneath, and a filled square on top for each
  // active day. When he reaches up for it, the square floats down into his
  // hands and becomes the ball.
  const shotFor = new Map(tl.shots.map((s) => [s.day.date, s]));
  const empty = [];
  const filled = [];
  weeks.forEach((week, i) => {
    for (const day of week.contributionDays) {
      const cx = GX + i * STEP, cy = cellY(day.weekday);
      const rect = `x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2"`;
      empty.push(`<rect ${rect} fill="${pal.cells[0]}"/>`);
      const level = LEVELS[day.contributionLevel] ?? 0;
      const s = shotFor.get(day.date);
      if (level === 0 || !s) continue;
      const dx = s.grabX + SCALE - (cx + CELL / 2), dy = FY - HAND_Y - (cy + CELL / 2);
      const cls = `d${day.date.replaceAll('-', '')}`;
      anim(cls, [
        [s.grab - EPS, `${tr(0, 0)};opacity:1`],
        [s.caught, `${tr(dx, dy)};opacity:1`],
        [s.caught + EPS, `${tr(dx, dy)};opacity:0`],
        [tl.end, `${tr(0, 0)};opacity:0`],
        [T, `${tr(0, 0)};opacity:1`],
      ], 'animation-timing-function:ease-out');
      filled.push(`<rect class="${cls}" ${rect} fill="${pal.cells[level]}"/>`);
    }
  });
  els.push(`<g>${empty.join('')}</g>`, ...filled);

  // Court and hoop.
  els.push(`<line x1="0" y1="${FY + 0.5}" x2="${W}" y2="${FY + 0.5}" stroke="${pal.floor}" stroke-width="1"/>`);
  els.push(`<rect x="872" y="112" width="4" height="${FY - 112}" fill="${pal.pole}"/>`);
  els.push(`<rect x="864" y="114" width="8" height="3" fill="${pal.pole}"/>`);
  els.push(`<rect x="861.5" y="96.5" width="4" height="40" fill="${pal.board}" stroke="${pal.boardLine}"/>`);
  css.push(keyframes('net', [[0, 'transform:scaleY(1)'],
    ...tl.shots.flatMap(({ swish: a }) => [[a, 'transform:scaleY(1)'], [a + 0.08, 'transform:scaleY(1.35)'], [a + 0.25, 'transform:scaleY(1)']]),
    [tl.dunk.at + 0.05, 'transform:scaleY(1)'], [tl.dunk.at + 0.15, 'transform:scaleY(1.45)'], [tl.dunk.at + 0.4, 'transform:scaleY(1)'],
  ], T));
  css.push(`.net{animation:net ${T.toFixed(2)}s linear infinite;transform-box:fill-box;transform-origin:50% 0}`);
  const ny = RIM.y + 1, nb = RIM.y + 17;
  els.push(`<g class="net" stroke="${pal.net}" stroke-width="1" fill="none">` +
    `<path d="M${RIM.x1} ${ny} L${RIM.x1 + 6} ${nb} L${RIM.x2 - 6} ${nb} L${RIM.x2} ${ny}"/>` +
    `<path d="M${RIM.x1 + 7} ${ny} L${RIM.x1 + 9} ${nb} M${RIM.x2 - 7} ${ny} L${RIM.x2 - 9} ${nb}"/>` +
    `<path d="M${RIM.x1 + 3} ${ny + 8} L${RIM.x2 - 3} ${ny + 8}"/></g>`);

  // Shots: the ball is the day's bubble, in its own green. Every one arcs in,
  // drops through the net and rolls away, and the day's count pops up by the rim.
  const ballSvg = (cls, fill) => `<g class="${cls}"><circle r="${BALL_R}" fill="${fill}"/>` +
    `<path d="M-${BALL_R} 0H${BALL_R}M0 -${BALL_R}V${BALL_R}" stroke="${BALL.seam}" stroke-opacity="0.45" stroke-width="0.8"/></g>`;
  const floorY = FY - BALL_R;
  const hidden = (x, y) => `${tr(x, y)};opacity:0`;
  tl.shots.forEach((s, k) => {
    const from = [s.x + SCALE, s.y];
    const a = s.swish;
    anim(`s${k}`, [
      [0, hidden(...from)], [s.release - EPS, hidden(...from)],
      ...arc(from, [RIM_CX, RIM.y - 2], s.release, s.flight),
      [a + 0.15, `${tr(RIM_CX, RIM.y + 20)};opacity:1`],
      [a + 0.35, `${tr(RIM_CX, floorY)};opacity:1`],
      [a + 0.5, `${tr(RIM_CX - 6, floorY - 12)};opacity:1`],
      [a + 0.65, `${tr(RIM_CX - 12, floorY)};opacity:1`],
      [a + 0.85, `${tr(RIM_CX - 18, floorY)};opacity:0`],
    ]);
    els.push(ballSvg(`s${k}`, pal.cells[LEVELS[s.day.contributionLevel] ?? 1]));

    anim(`p${k}`, [
      [0, `${tr(0, 0)};opacity:0`], [a - EPS, `${tr(0, 0)};opacity:0`],
      [a, `${tr(0, 0)};opacity:1`], [a + 1.1, `${tr(0, -16)};opacity:0`],
    ]);
    els.push(`<text class="p${k}" x="${RIM_CX - 36}" y="${RIM.y - 8}" text-anchor="middle" font-size="12" font-weight="700" fill="${pal.gold}">+${s.count}</text>`);
  });

  // Dunk ball: travels in the player's hands, then drops through the rim.
  const dunkHidden = hidden(RIM_CX, RIM.y - 8);
  anim('dunkball', [
    [0, dunkHidden], [tl.dunk.at - EPS, dunkHidden],
    [tl.dunk.at, `${tr(RIM_CX, RIM.y - 8)};opacity:1`],
    [tl.dunk.at + 0.2, `${tr(RIM_CX, RIM.y + 22)};opacity:1`],
    [tl.dunk.at + 0.4, `${tr(RIM_CX, floorY)};opacity:1`],
    [tl.dunk.at + 0.6, `${tr(RIM_CX + 4, floorY - 16)};opacity:1`],
    [tl.dunk.at + 0.8, `${tr(RIM_CX + 8, floorY)};opacity:1`],
    [tl.dunk.at + 0.92, `${tr(RIM_CX + 10, floorY - 6)};opacity:1`],
    [tl.dunk.at + 1.04, `${tr(RIM_CX + 12, floorY)};opacity:1`],
    [tl.end, `${tr(RIM_CX + 12, floorY)};opacity:1`],
    [tl.end + FADE * 0.5, `${tr(RIM_CX + 12, floorY)};opacity:0`],
  ]);
  els.push(ballSvg('dunkball', pal.cells[4]));

  // Drawn after the balls so they pass behind the front of the rim.
  els.push(`<line x1="${RIM.x1}" y1="${RIM.y}" x2="${RIM.x2 + 2}" y2="${RIM.y}" stroke="${pal.rim}" stroke-width="2.5" stroke-linecap="round"/>`);

  // Player: pixel sprite with its feet at (0, 0), facing the hoop, in a blue
  // jersey with gold trim and number, blue shorts with a gold waistband.
  const r = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  const legs = (lx, rx, rh) =>
    r(lx, -8, 2, 6, PLAYER.skin) + r(lx, -2, 2, 2, PLAYER.shoes) +
    r(rx, -8, 2, rh, PLAYER.skin) + r(rx, -8 + rh, 2, 2, PLAYER.shoes);
  // Legs stride only while he is moving; otherwise he stands.
  css.push('@keyframes stride{0%{opacity:1}50%{opacity:0}}');
  css.push('.legA{animation:stride .36s steps(1) infinite}.legB{animation:stride .36s steps(1) infinite;animation-delay:-.18s}');
  css.push('@keyframes bounce{0%{transform:translateY(-8px)}100%{transform:translateY(0)}}');
  css.push('.bounce{animation:bounce .24s ease-in infinite alternate}');
  anim('player', tl.player.map(([t, x, y]) => [t, tr(x, FY + y)]));
  anim('walk', windows(tl.walking, T, 1, 0));
  anim('stand', windows(tl.walking, T, 0, 1));
  anim('arms-up', windows(tl.armsUp, T, 1, 0));
  anim('arms-down', windows(tl.armsUp, T, 0, 1));
  anim('dribble', windows(tl.holding.map((h) => [h.from, h.to]), T, 1, 0));
  // The ball he's holding takes the colour of the bubble he grabbed.
  const fills = [[0, `fill:${pal.cells[1]}`]];
  for (const h of tl.holding) fills.push([h.from - EPS, fills.at(-1)[1]], [h.from, `fill:${pal.cells[h.level]}`]);
  css.push(keyframes('ballfill', fills, T));
  anim('fadeplayer', [[0, 'opacity:0'], [0.4, 'opacity:1'], [tl.end, 'opacity:1'], [tl.end + FADE * 0.5, 'opacity:0']]);
  els.push(`<g class="fadeplayer"><g class="player"><g transform="scale(${SCALE})">` +
    `<g class="stand">${legs(-3, 1, 6)}</g>` +
    `<g class="walk"><g class="legA">${legs(-3, 1, 6)}</g><g class="legB">${legs(-4, 2, 4)}</g></g>` +
    r(-4, -12, 8, 4, PLAYER.blue) + r(-4, -12, 8, 1, PLAYER.gold) + r(3, -11, 1, 3, PLAYER.gold) +
    r(-4, -20, 8, 8, PLAYER.blue) + r(-2, -20, 4, 1, PLAYER.gold) + r(-4, -20, 1, 8, PLAYER.gold) +
    r(3, -20, 1, 8, PLAYER.gold) + r(-1, -18, 2, 4, PLAYER.gold) +
    r(-3, -26, 6, 6, PLAYER.skin) + r(-3, -26, 6, 2, PLAYER.hair) + r(1, -24, 1, 1, PLAYER.hair) +
    `<g class="arms-down">${r(-6, -19, 2, 6, PLAYER.skin)}${r(4, -19, 2, 7, PLAYER.skin)}</g>` +
    `<g class="arms-up">${r(-3, -34, 2, 14, PLAYER.skin)}${r(1, -34, 2, 14, PLAYER.skin)}` +
    `<circle class="handball" cx="1" cy="-36" r="${BALL_R / SCALE}"/></g>` +
    `<g class="dribble"><g class="bounce"><circle class="held" cx="7" cy="-2.6" r="2.6"/></g></g>` +
    `</g></g></g>`);

  // The ball in his hands shows from the gather to the release; the shot ball takes over.
  css.push(keyframes('handball', windows([
    ...tl.shots.map((s) => [s.release - RISE, s.release]),
    [tl.dunk.takeoff, tl.dunk.at],
  ], T, 1, 0), T));
  const dur = `${T.toFixed(2)}s linear infinite`;
  css.push(`.handball{animation:handball ${dur},ballfill ${dur}}.held{animation:ballfill ${dur}}`);

  // Scoreboard: running total, plus the last bucket's date and count.
  const steps = [[0, 0], ...tl.scores];
  const resetAt = tl.end + FADE * 0.5;
  steps.forEach(([t0, value], k) => {
    const t1 = k + 1 < steps.length ? steps[k + 1][0] : resetAt;
    const shown = k === 0 ? [[0, t1 - EPS], [resetAt, T]] : [[t0, t1 - EPS]];
    anim(`score${k}`, windows(shown, T));
    els.push(`<text class="score${k}" x="${W - 12}" y="22" text-anchor="end" font-size="18" font-weight="700" fill="${pal.strong}">${value.toLocaleString('en-US')}</text>`);
  });
  els.push(`<text x="${W - 12}" y="35" text-anchor="end" font-size="9" letter-spacing="1" fill="${pal.text}">PTS</text>`);
  tl.shots.forEach((s, k) => {
    const next = tl.shots[k + 1]?.swish ?? resetAt;
    anim(`last${k}`, windows([[s.swish, next - EPS]], T));
    els.push(`<text class="last${k}" x="${W - 12}" y="50" text-anchor="end" font-size="10" fill="${pal.gold}">${shortDate(s.day.date)} · ${s.count}</text>`);
  });

  els.push(`<text x="${GX}" y="${H - 3}" font-size="10" fill="${pal.text}">${calendar.totalContributions.toLocaleString('en-US')} contributions in the last year · one shot for every day i shipped · ${tl.shots.length} for ${tl.shots.length}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">` +
    `<title>${USER}'s contributions, played as a game of basketball: one made shot for every day with contributions</title>` +
    `<style>${css.join('')}</style>${els.join('')}</svg>`;
}

// ---------- main ----------

const calendar = args.fixture
  ? JSON.parse(readFileSync(args.fixture, 'utf8'))
  : await fetchCalendar(USER, process.env.GITHUB_TOKEN);

if (args.debug) {
  // --debug N prints the timing of shot N, for freezing frames while tweaking.
  const tl = buildTimeline(calendar.weeks);
  const s = tl.shots[Number(args.debug)];
  console.error(JSON.stringify({ T: +tl.T.toFixed(2), shots: tl.shots.length, grab: s.grab, caught: s.caught, release: s.release, swish: s.swish, day: s.day.date }));
}

mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(PALETTES)) {
  const file = join(OUT, name === 'light' ? 'hoops.svg' : 'hoops-dark.svg');
  writeFileSync(file, render(calendar, name));
  console.log(`wrote ${file}`);
}
