'use strict';

// ──────────────────────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────────────────────
// 1 light-year per year is exactly c, so velocities in units of c and
// distances in ly stay unit-consistent against times in years with no
// conversion factor anywhere below.
const LY_PER = { ly: 1, pc: 3.26156, kly: 1000 };

// Total potentially-habitable planets ever formed in the galaxy, order-of-magnitude
// (consistent with Kepler-occurrence-rate estimates of ~10^8-10^9), collapsed from
// the classical Drake terms R*·f_p·n_e. Calibrated so that, at default astrophysical
// timing and the GHZ constraint on, P(intelligence)~1e-6 alone yields N~1 — see
// scratchpad calibration notes in the PR description.
const LAMBDA_MAX = 6e8;

// Verdict thresholds on N_arrived / N_detectable (see verdict() below).
const QUIET_MAX = 2;
const MARGINAL_MAX = 10;

// ──────────────────────────────────────────────────────────────
// MATH: Lanczos gamma function, Gamma PDF
// ──────────────────────────────────────────────────────────────
function lanczosGamma(z) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * lanczosGamma(1 - z));
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

function gammaPdf(x, k, theta) {
  if (x <= 0) return 0;
  return Math.pow(x, k - 1) * Math.exp(-x / theta) / (Math.pow(theta, k) * lanczosGamma(k));
}

// ──────────────────────────────────────────────────────────────
// STAR FORMATION RATE SHAPES (normalized to integrate to 1 over [0,T])
// ──────────────────────────────────────────────────────────────
function sfrRaw(t, kind) {
  if (kind === 'flat') return 1;
  if (kind === 'early-peak') return Math.exp(-t / 1.5);
  return t * Math.exp(-t / 3.5); // 'observed' — rises, peaks ~3.5 Gyr, long decline
}

function makeGrid(T, n) {
  const dt = T / n;
  const ts = new Array(n + 1);
  for (let i = 0; i <= n; i++) ts[i] = i * dt;
  return { ts, dt };
}

function trapz(vals, dt) {
  let sum = 0;
  for (let i = 0; i < vals.length; i++) sum += vals[i] * (i === 0 || i === vals.length - 1 ? 0.5 : 1);
  return sum * dt;
}

// ──────────────────────────────────────────────────────────────
// EMERGENCE MODEL: metallicity gate -> Gamma bio-clock convolution
// ──────────────────────────────────────────────────────────────
// Returns { ts, dt, density, fGate } where `density` (civilizations-per-Gyr
// density, NOT renormalized to 1) integrates to fGate minus whatever mass the
// bio-clock convolution pushed past T (hasn't happened yet). fGate itself is
// the fraction of all star formation that occurred after the metallicity floor.
function emergenceDensity({ T, sfrKind, tMetal, mu, sigma, n = 360 }) {
  const { ts, dt } = makeGrid(T, n);
  const sfrVals = ts.map(t => sfrRaw(t, sfrKind));
  const sfrNorm = trapz(sfrVals, dt);
  const density = sfrVals.map(v => v / sfrNorm);
  const gated = ts.map((t, i) => (t >= tMetal ? density[i] : 0));
  const fGate = trapz(gated, dt);

  const k = (mu / sigma) ** 2;
  const theta = (sigma * sigma) / mu;
  const out = new Array(n + 1).fill(0);
  for (let i = 0; i <= n; i++) {
    const wPlanet = gated[i] * (i === 0 || i === n ? 0.5 : 1) * dt;
    if (wPlanet === 0) continue;
    const tPlanet = ts[i];
    for (let j = i; j <= n; j++) {
      const delta = ts[j] - tPlanet;
      if (delta <= 0) continue;
      out[j] += wPlanet * gammaPdf(delta, k, theta);
    }
  }
  return { ts, dt, density: out, fGate };
}

function cdfAt(ts, dt, density, tStar) {
  if (tStar <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] > tStar) break;
    sum += density[i] * dt;
  }
  return sum;
}

// ──────────────────────────────────────────────────────────────
// EXPANSION MODEL
// ──────────────────────────────────────────────────────────────
function expansionModel({ v, hopLy, dwell, k, failPct, R }) {
  const s = 1 - failPct / 100;
  const cycle = hopLy / v + dwell; // years per hop-generation
  const vWave = hopLy / cycle;     // ly/yr === fraction of c
  const tCrossYr = (2 * R) / vWave;
  const stalled = k * s <= 1;
  return { s, cycle, vWave, tCrossYr, tCrossGyr: tCrossYr / 1e9, stalled, branching: k * s };
}

function ghzVolume(rIn, rOut, thickness) {
  return Math.PI * (rOut ** 2 - rIn ** 2) * thickness;
}
function fullDiskVolume(R, thickness) {
  return Math.PI * R ** 2 * thickness;
}

// ──────────────────────────────────────────────────────────────
// FULL SCENARIO EVALUATION
// ──────────────────────────────────────────────────────────────
function evaluateScenario(p) {
  const exp = expansionModel({ v: p.v, hopLy: p.hopLy, dwell: p.dwell, k: p.k, failPct: p.fail, R: p.R });
  const em = emergenceDensity({ T: p.T, sfrKind: p.sfr, tMetal: p.tMetal, mu: p.mu, sigma: p.sigma });

  const ghzVol = ghzVolume(p.ghzIn, p.ghzOut, p.thick);
  const fullVol = fullDiskVolume(p.R, p.thick);
  const lambda = p.ghz ? LAMBDA_MAX * (ghzVol / fullVol) : LAMBDA_MAX;

  const flVal = Math.pow(10, p.fl);
  const fiVal = Math.pow(10, p.fi);
  const rarity = flVal * fiVal * p.fc;

  const massAtT = cdfAt(em.ts, em.dt, em.density, p.T);
  const nLaunched = lambda * rarity * massAtT;

  // A stalled front dies out within a few hop-cycles of its origin and never gets
  // anywhere near crossing distance — arrival/detectability are moot, not just small.
  const tArriveCutoff = p.T - exp.tCrossGyr;
  const massArrived = (!exp.stalled && tArriveCutoff > 0) ? cdfAt(em.ts, em.dt, em.density, tArriveCutoff) : 0;
  const nArrived = exp.stalled ? 0 : lambda * rarity * massArrived;
  const nDetectable = exp.stalled ? 0 : nArrived * p.detect;

  // Earliest time cumulative launched count reaches 1 civilization.
  let tEarliest = null;
  let running = 0;
  for (let i = 0; i < em.ts.length; i++) {
    running += em.density[i] * em.dt * lambda * rarity;
    if (running >= 1) { tEarliest = em.ts[i]; break; }
  }

  let verdict;
  if (exp.stalled) verdict = 'STALLED';
  else if (nArrived < QUIET_MAX) verdict = 'QUIET';
  else if (nArrived < MARGINAL_MAX) verdict = 'MARGINAL';
  else if (nDetectable >= MARGINAL_MAX) verdict = 'SATURATED';
  else verdict = 'DORMANT';

  const filter = Math.max(1, nDetectable);
  const usedVol = p.ghz ? ghzVol : fullVol;
  const saturationCeiling = p.density * usedVol;

  return {
    exp, em, lambda, rarity, flVal, fiVal,
    massAtT, nLaunched, massArrived, nArrived, nDetectable,
    tEarliest, verdict, filter, ghzVol, fullVol, usedVol, saturationCeiling,
  };
}

// ──────────────────────────────────────────────────────────────
// COLONIZATION FRONT TIME SERIES (Chart 1)
// ──────────────────────────────────────────────────────────────
function frontSeries(exp, p, saturationCeiling) {
  const horizon = Math.max(exp.tCrossYr * 2.2, exp.cycle * 30);
  const N_PTS = 240;
  const pts = [];
  const t0 = Math.max(1, exp.cycle / 20);
  for (let i = 0; i <= N_PTS; i++) {
    // log-spaced time samples from t0 to horizon
    const frac = i / N_PTS;
    const t = t0 * Math.pow(horizon / t0, frac);
    const generations = t / exp.cycle;
    const nExp = Math.pow(Math.max(exp.branching, 1e-9), generations);
    const r = Math.min(exp.vWave * t, p.R);
    const nFrontier = p.density * Math.PI * r * r * p.thick;
    const n = Math.min(nExp, nFrontier, saturationCeiling);
    pts.push({ x: t, y: Math.max(n, 1e-6) });
  }
  return pts;
}

// ──────────────────────────────────────────────────────────────
// FORMATTERS
// ──────────────────────────────────────────────────────────────
function fmtYears(y) {
  const abs = Math.abs(y);
  if (abs < 1e3) return `${y.toFixed(0)} yr`;
  if (abs < 1e6) return `${(y / 1e3).toFixed(2)} kyr`;
  if (abs < 1e9) return `${(y / 1e6).toFixed(2)} Myr`;
  return `${(y / 1e9).toFixed(3)} Gyr`;
}
function fmtGyr(g) { return `${g.toFixed(3)} Gyr`; }
function fmtCount(n) {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 0.001) return n.toExponential(2);
  if (abs < 1000) return n.toFixed(abs < 10 ? 2 : 1);
  if (abs < 1e6) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toExponential(2);
}
function fmtSci(n, digits = 1) {
  if (n === 0) return '0';
  const s = n.toExponential(digits);
  const [mant, exp] = s.split('e');
  const supers = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  const expNum = parseInt(exp, 10);
  const expStr = String(Math.abs(expNum)).split('').map(c => supers[c]).join('');
  return `${mant}×10${expNum < 0 ? supers['-'] : ''}${expStr}`;
}
function fmtPct(x) { return `${(x * 100).toFixed(1)}%`; }
function fmtLog(exp) { return fmtSci(Math.pow(10, exp), 1); }

// ──────────────────────────────────────────────────────────────
// PRESETS
// ──────────────────────────────────────────────────────────────
const PRESETS = {
  'classic-hart-tipler': {
    label: 'Classic Hart–Tipler',
    v: 0.1, hopLy: 5, dwell: 200, k: 5, fail: 5,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 5.0, mu: 4.5, sigma: 1.0, sfr: 'observed',
    fl: -2, fi: -3, fc: 0.5, detect: 0.5,
    blurb: 'Fast probes, short dwell, aggressive replication. The wave crosses the galaxy in about 5 million years — a blink of an eye against a 13.6-billion-year galactic history. If this is remotely realistic, the silence is a real paradox.',
  },
  'slow-crawl': {
    label: 'Slow Crawl',
    v: 0.01, hopLy: 25, dwell: 10000, k: 3, fail: 10,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 5.0, mu: 4.5, sigma: 1.0, sfr: 'observed',
    fl: -2, fi: -3, fc: 0.5, detect: 0.5,
    blurb: 'Ten times slower, hundred-fold longer dwell, ~50 million years to cross the galaxy — and it barely matters. Even a lumbering, patient wave still gets there with tens of millions of years to spare. Speed was never the load-bearing assumption.',
  },
  'late-metallicity': {
    label: 'Late Metallicity',
    v: 0.1, hopLy: 5, dwell: 200, k: 5, fail: 5,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 11.0, mu: 4.5, sigma: 1.0, sfr: 'observed',
    fl: -2, fi: -3, fc: 0.5, detect: 0.5,
    blurb: 'Same fast probes as Classic Hart–Tipler — nothing about the engineering changed. Push the metallicity floor late enough and almost no planet has had the 4.5 Gyr biological clock to run out yet. Nobody has launched. The silence needs no filter at all.',
  },
  'rare-intelligence': {
    label: 'Rare Intelligence',
    v: 0.1, hopLy: 5, dwell: 200, k: 5, fail: 5,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 5.0, mu: 4.5, sigma: 1.0, sfr: 'observed',
    fl: -2, fi: -5.55, fc: 0.5, detect: 0.5,
    blurb: 'Same nominal probes, same timing — only P(intelligence | life) moves, down to about one in three hundred thousand. The expected count of civilizations that ever launched a wave toward us drops to roughly one. That one could easily be us.',
  },
  'percolation-stall': {
    label: 'Percolation Stall',
    v: 0.1, hopLy: 5, dwell: 200, k: 2, fail: 55,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 5.0, mu: 4.5, sigma: 1.0, sfr: 'observed',
    fl: -2, fi: -3, fc: 0.5, detect: 0.5,
    blurb: 'Replication factor 2, failure rate 55% — branching factor k·s = 0.9, just under the k·s ≤ 1 stall line. Every generation produces fewer daughter waves than the one before. The front doesn’t slow down toward the galaxy’s edge; it dies out long before reaching it, regardless of how much time is available.',
  },
  'we-are-first': {
    label: 'We Are First',
    v: 0.05, hopLy: 5, dwell: 300, k: 3, fail: 10,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 5.0, mu: 11.0, sigma: 1.2, sfr: 'observed',
    fl: -2, fi: -3, fc: 0.5, detect: 0.5,
    blurb: 'Metallicity is unremarkable, but the mean biological clock runs long — 11 Gyr from rocky planet to tech civilization. Earth, on this reading, isn’t special for succeeding; it’s just an early finisher in a race almost everyone else is still running. Plausibly nobody else has crossed the line yet.',
  },
  'berserker': {
    label: 'Berserker',
    v: 0.3, hopLy: 5, dwell: 50, k: 8, fail: 2,
    density: 0.004, R: 50000, ghz: true, ghzIn: 13000, ghzOut: 32600, thick: 1000,
    T: 13.6, tMetal: 5.0, mu: 4.5, sigma: 1.0, sfr: 'observed',
    fl: -2, fi: -3, fc: 0.5, detect: 0.005,
    blurb: 'Nothing here is gentle: 0.3c, minimal dwell, aggressive replication, almost no losses. By the numbers, colonization waves should have reached us hundreds of times over. Set detectability to near-zero — deliberately stealthed, predatory probes — and the model still resolves to a quiet sky. That combination is the unsettling reading: not “nobody’s out there,” but “they could already be here, and silent for a reason.”',
  },
};

// ──────────────────────────────────────────────────────────────
// DOM ELEMENT REFS
// ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  v: $('v-cruise'), hopVal: $('hop-val'), hopUnit: $('hop-unit'), dwell: $('dwell'),
  k: $('k-repl'), fail: $('fail-rate'),
  density: $('target-density'), R: $('galaxy-radius'), ghz: $('use-ghz'), ghzFields: $('ghz-fields'),
  ghzIn: $('ghz-inner'), ghzOut: $('ghz-outer'), thick: $('disk-thickness'),
  T: $('galaxy-age'), tMetal: $('t-metal'), mu: $('bio-mean'), sigma: $('bio-sigma'), sfr: $('sfr-curve'),
  fl: $('p-abio'), flOut: $('p-abio-readout'),
  fi: $('p-intel'), fiOut: $('p-intel-readout'),
  fc: $('p-launch'), fcOut: $('p-launch-readout'),
  detect: $('p-detect'), detectOut: $('p-detect-readout'),
  stoch: $('use-stochastic'), stochFields: $('stochastic-fields'), runs: $('run-count'), seed: $('seed'),
  runBtn: $('run-btn'), progressWrap: $('progress-wrap'), progressFill: $('progress-fill'), progressLabel: $('progress-label'),
  preview: $('colonization-preview'),
  noResults: $('no-results'), results: $('results-content'),
  verdictCard: $('verdict-card'), verdictBadge: $('verdict-badge'), scenarioName: $('scenario-name'), verdictBody: $('verdict-body'),
  metricsGrid: $('metrics-grid'),
  tabMc: $('tab-montecarlo'), mcSummary: $('mc-summary'),
  presets: $('presets'),
};

// ──────────────────────────────────────────────────────────────
// PARAM <-> FORM
// ──────────────────────────────────────────────────────────────
function readParams() {
  return {
    v: parseFloat(el.v.value),
    hopLy: parseFloat(el.hopVal.value) * LY_PER[el.hopUnit.value],
    dwell: parseFloat(el.dwell.value),
    k: parseFloat(el.k.value),
    fail: parseFloat(el.fail.value),
    density: parseFloat(el.density.value),
    R: parseFloat(el.R.value),
    ghz: el.ghz.checked,
    ghzIn: parseFloat(el.ghzIn.value),
    ghzOut: parseFloat(el.ghzOut.value),
    thick: parseFloat(el.thick.value),
    T: parseFloat(el.T.value),
    tMetal: parseFloat(el.tMetal.value),
    mu: parseFloat(el.mu.value),
    sigma: parseFloat(el.sigma.value),
    sfr: el.sfr.value,
    fl: parseFloat(el.fl.value),
    fi: parseFloat(el.fi.value),
    fc: parseFloat(el.fc.value),
    detect: parseFloat(el.detect.value),
    stoch: el.stoch.checked,
    runs: parseInt(el.runs.value, 10),
    seed: parseInt(el.seed.value, 10) || 0,
  };
}

function applyParams(p) {
  el.v.value = p.v;
  const unit = el.hopUnit.value;
  el.hopVal.value = +(p.hopLy / LY_PER[unit]).toPrecision(6);
  el.dwell.value = p.dwell;
  el.k.value = p.k;
  el.fail.value = p.fail;
  el.density.value = p.density;
  el.R.value = p.R;
  el.ghz.checked = p.ghz;
  el.ghzIn.value = p.ghzIn;
  el.ghzOut.value = p.ghzOut;
  el.thick.value = p.thick;
  el.T.value = p.T;
  el.tMetal.value = p.tMetal;
  el.mu.value = p.mu;
  el.sigma.value = p.sigma;
  el.sfr.value = p.sfr;
  el.fl.value = p.fl;
  el.fi.value = p.fi;
  el.fc.value = p.fc;
  el.detect.value = p.detect;
  el.stoch.checked = !!p.stoch;
  if (p.runs) el.runs.value = String(p.runs);
  if (p.seed !== undefined) el.seed.value = p.seed;
  syncDerivedUI();
}

function syncDerivedUI() {
  el.flOut.innerHTML = fmtLog(parseFloat(el.fl.value));
  el.fiOut.innerHTML = fmtLog(parseFloat(el.fi.value));
  el.fcOut.textContent = parseFloat(el.fc.value).toFixed(2);
  el.detectOut.textContent = parseFloat(el.detect.value).toFixed(3);
  el.ghzFields.hidden = !el.ghz.checked;
  el.stochFields.hidden = !el.stoch.checked;
  updatePreview();
}

// ──────────────────────────────────────────────────────────────
// LIVE PREVIEW (cheap, no chart work — runs on every input)
// ──────────────────────────────────────────────────────────────
function updatePreview() {
  const p = readParams();
  if (!isFinite(p.v) || p.v <= 0 || !isFinite(p.hopLy) || p.hopLy <= 0) {
    el.preview.innerHTML = '&mdash;';
    return;
  }
  const exp = expansionModel({ v: p.v, hopLy: p.hopLy, dwell: p.dwell, k: p.k, failPct: p.fail, R: p.R });
  el.preview.innerHTML = `
    Wave velocity: <strong>${(exp.vWave * 100).toFixed(3)}% c</strong><br>
    Crossing time: <strong>${fmtYears(exp.tCrossYr)}</strong><br>
    Branching k&middot;s: <strong>${exp.branching.toFixed(2)}</strong> ${exp.stalled ? '<span style="color:var(--err)">(stalls)</span>' : '(sustains)'}
  `;
}

// ──────────────────────────────────────────────────────────────
// URL HASH STATE
// ──────────────────────────────────────────────────────────────
let ignoreNextHashChange = false;

function encodeHash(p, presetId) {
  if (presetId) return `p=${presetId}`;
  const parts = [
    `v=${p.v}`, `hop=${p.hopLy}`, `dwell=${p.dwell}`, `k=${p.k}`, `fail=${p.fail}`,
    `dens=${p.density}`, `R=${p.R}`, `ghz=${p.ghz ? 1 : 0}`, `gin=${p.ghzIn}`, `gout=${p.ghzOut}`, `th=${p.thick}`,
    `T=${p.T}`, `tm=${p.tMetal}`, `mu=${p.mu}`, `sig=${p.sigma}`, `sfr=${p.sfr}`,
    `fl=${p.fl}`, `fi=${p.fi}`, `fc=${p.fc}`, `det=${p.detect}`,
    `mc=${p.stoch ? 1 : 0}`, `runs=${p.runs}`, `seed=${p.seed}`,
  ];
  return parts.join('&');
}

function parseHash(hash) {
  const qs = new URLSearchParams(hash.replace(/^#/, ''));
  if (qs.has('p')) return { presetId: qs.get('p') };
  if ([...qs.keys()].length === 0) return null;
  const f = (k, def) => (qs.has(k) ? parseFloat(qs.get(k)) : def);
  return {
    params: {
      v: f('v', 0.01), hopLy: f('hop', 5), dwell: f('dwell', 500), k: f('k', 2), fail: f('fail', 5),
      density: f('dens', 0.004), R: f('R', 50000), ghz: qs.get('ghz') !== '0', ghzIn: f('gin', 13000), ghzOut: f('gout', 32600), thick: f('th', 1000),
      T: f('T', 13.6), tMetal: f('tm', 5), mu: f('mu', 4.5), sigma: f('sig', 1), sfr: qs.get('sfr') || 'observed',
      fl: f('fl', -2), fi: f('fi', -3), fc: f('fc', 0.5), detect: f('det', 0.5),
      stoch: qs.get('mc') === '1', runs: parseInt(qs.get('runs') || '1000', 10), seed: parseInt(qs.get('seed') || '42', 10),
    },
  };
}

function updateHash(presetId) {
  const p = readParams();
  const newHash = `#${encodeHash(p, presetId)}`;
  if (location.hash === newHash) return;
  ignoreNextHashChange = true;
  location.hash = newHash;
}

// ──────────────────────────────────────────────────────────────
// SEEDED RNG + LOG-UNIFORM SAMPLING
// ──────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleLogUniform(rng, minExp, maxExp) {
  return Math.pow(10, minExp + rng() * (maxExp - minExp));
}

// ──────────────────────────────────────────────────────────────
// CHARTS
// ──────────────────────────────────────────────────────────────
let chartFront = null, chartEmergence = null, chartMc = null;

const cLinePlugin = {
  id: 'vline',
  afterDraw(chart) {
    const opts = chart.options.plugins?.vline;
    if (!opts?.x) return;
    const xScale = chart.scales.x;
    const xPx = xScale.getPixelForValue(opts.x);
    const { ctx, chartArea: ca } = chart;
    if (xPx < ca.left || xPx > ca.right) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ca.left, ca.top, ca.width, ca.height);
    ctx.clip();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = opts.color || 'rgba(251,191,36,0.7)';
    ctx.lineWidth = 1.5;
    ctx.moveTo(xPx, ca.top);
    ctx.lineTo(xPx, ca.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.fillStyle = opts.color || 'rgba(251,191,36,0.85)';
    ctx.textAlign = xPx > ca.right - 60 ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.label || '', xPx + (xPx > ca.right - 60 ? -6 : 6), ca.top + 4);
    ctx.restore();
  },
};
Chart.register(cLinePlugin);

const hLinePlugin = {
  id: 'hline',
  afterDraw(chart) {
    const opts = chart.options.plugins?.hline;
    if (!opts?.y) return;
    const yScale = chart.scales.y;
    const yPx = yScale.getPixelForValue(opts.y);
    const { ctx, chartArea: ca } = chart;
    if (yPx < ca.top || yPx > ca.bottom) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ca.left, ca.top, ca.width, ca.height);
    ctx.clip();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(167,139,250,0.55)';
    ctx.lineWidth = 1.5;
    ctx.moveTo(ca.left, yPx);
    ctx.lineTo(ca.right, yPx);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.fillStyle = 'rgba(167,139,250,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label || 'saturation ceiling', ca.left + 6, yPx - 4);
    ctx.restore();
  },
};
Chart.register(hLinePlugin);

function renderFrontChart(pts, exp, saturationCeiling) {
  const ctx = $('cv-front').getContext('2d');
  if (chartFront) chartFront.destroy();
  chartFront = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Systems occupied',
        data: pts,
        borderColor: '#a78bfa',
        backgroundColor: 'rgba(167,139,250,0.12)',
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.15,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      scales: {
        x: { type: 'logarithmic', title: { display: true, text: 'Time since launch (years)', color: '#7a96b4' }, ticks: { color: '#7a96b4' }, grid: { color: 'rgba(255,255,255,.05)' } },
        y: { type: 'logarithmic', title: { display: true, text: 'Systems occupied', color: '#7a96b4' }, ticks: { color: '#7a96b4' }, grid: { color: 'rgba(255,255,255,.05)' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmtCount(c.parsed.y)} systems at ${fmtYears(c.parsed.x)}` } },
        vline: { x: exp.tCrossYr, label: 'Earth reached', color: 'rgba(251,191,36,0.85)' },
        hline: { y: saturationCeiling, label: 'saturation ceiling' },
      },
    },
  });
}

function renderEmergenceChart(em, lambda, rarity, T, tCross) {
  const cutoff = T - tCross;
  const pts = em.ts.map((t, i) => ({ x: t, y: lambda * rarity * em.density[i] }));
  const ctx = $('cv-emergence').getContext('2d');
  if (chartEmergence) chartEmergence.destroy();
  chartEmergence = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Already launched & reached us',
          data: pts.filter(pt => pt.x <= Math.max(cutoff, 0)),
          borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.28)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15,
        },
        {
          label: 'Emerged, wave not here yet',
          data: pts.filter(pt => pt.x >= Math.max(cutoff, 0)),
          borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.14)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      scales: {
        x: { type: 'linear', min: 0, max: T, title: { display: true, text: 'Gyr since Big Bang', color: '#7a96b4' }, ticks: { color: '#7a96b4' }, grid: { color: 'rgba(255,255,255,.05)' } },
        y: { title: { display: true, text: 'Civilizations / Gyr', color: '#7a96b4' }, ticks: { color: '#7a96b4' }, grid: { color: 'rgba(255,255,255,.05)' }, beginAtZero: true },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a96b4', boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: { label: c => `${fmtCount(c.parsed.y)} civ/Gyr at t=${c.parsed.x.toFixed(2)} Gyr` } },
        vline: { x: T, label: 'NOW (Earth)', color: 'rgba(248,113,113,0.8)' },
      },
    },
  });
}

const MC_EDGES = [30, 100, 300, 1000, 3000, 10000, 30000, 1e5, 1e6];
function bucketLabel(n) {
  if (n <= 10) return String(Math.round(n));
  for (const e of MC_EDGES) if (n < e) return `<${fmtCount(e)}`;
  return `≥${fmtCount(MC_EDGES[MC_EDGES.length - 1])}`;
}
function mcLabelOrder() {
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  for (const e of MC_EDGES) labels.push(`<${fmtCount(e)}`);
  labels.push(`≥${fmtCount(MC_EDGES[MC_EDGES.length - 1])}`);
  return labels;
}

function renderMcChart(samples) {
  const bins = new Map();
  for (const n of samples) {
    const label = bucketLabel(n);
    bins.set(label, (bins.get(label) || 0) + 1);
  }
  const labelOrder = mcLabelOrder();
  const labels = labelOrder.filter(l => bins.has(l));
  const counts = labels.map(l => bins.get(l));

  const ctx = $('cv-montecarlo').getContext('2d');
  if (chartMc) chartMc.destroy();
  chartMc = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Runs',
        data: counts,
        backgroundColor: '#a78bfa',
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { title: { display: true, text: 'N civilizations arrived by now', color: '#7a96b4' }, ticks: { color: '#7a96b4' }, grid: { display: false } },
        y: { title: { display: true, text: 'Runs', color: '#7a96b4' }, ticks: { color: '#7a96b4' }, grid: { color: 'rgba(255,255,255,.05)' } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ──────────────────────────────────────────────────────────────
// TAB SWITCHING
// ──────────────────────────────────────────────────────────────
function activateTab(which) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  $('chart-front').hidden = which !== 'front';
  $('chart-emergence').hidden = which !== 'emergence';
  $('chart-montecarlo').hidden = which !== 'montecarlo';
  $('mc-summary').hidden = which !== 'montecarlo' || !el.stoch.checked;
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

// ──────────────────────────────────────────────────────────────
// RENDER RESULTS
// ──────────────────────────────────────────────────────────────
const VERDICT_TEXT = {
  SATURATED: 'The naive count of civilizations whose wave should already be here — and detectable — is large. If this scenario is realistic, the silence is a real paradox: something must be suppressing colonization far below what these numbers predict.',
  MARGINAL: 'The arrival window overlaps the present. It is genuinely ambiguous whether anyone has had time to reach us yet. Silence here is weak evidence either way.',
  QUIET: 'Nobody has plausibly had time to reach us — the crossing time is negligible against how few civilizations have emerged by now. No Great Filter is required; the silence is fully expected.',
  DORMANT: 'Waves should physically have reached us by now, but the detectability assumption is low enough that we would not necessarily notice. The paradox dissolves without invoking a biological filter — the limit is what we can detect, not what exists.',
  STALLED: 'The replication branching factor k·s is at or below 1 — the expansion front dies out before it ever reaches galactic scale, regardless of how much time has passed. This is a structural failure of the colonization wave, not a timing argument.',
};

function renderResults(scn, p) {
  el.noResults.hidden = true;
  el.results.hidden = false;

  el.verdictCard.className = `verdict-card v-${scn.verdict.toLowerCase()}`;
  el.verdictBadge.textContent = scn.verdict;
  el.scenarioName.textContent = p.presetLabel || 'Custom scenario';
  const arrivalNote = scn.exp.stalled
    ? ''
    : (scn.tEarliest !== null
      ? ` Earliest plausible launch: ${fmtGyr(scn.tEarliest)} after the Big Bang.`
      : ' No civilization is expected to have launched a single probe yet.');
  const blurbHtml = p.blurb ? `<p style="margin-bottom:8px">${p.blurb}</p>` : '';
  el.verdictBody.innerHTML = `${blurbHtml}${VERDICT_TEXT[scn.verdict]}${arrivalNote}`;

  const ghzNote = p.ghz ? `GHZ annulus (${fmtCount(p.ghzIn)}–${fmtCount(p.ghzOut)} ly)` : 'full uniform disk';
  el.metricsGrid.innerHTML = [
    metricCard('Wave Velocity', `${(scn.exp.vWave * 100).toFixed(3)}% c`, `${fmtYears(scn.exp.cycle)} per hop-cycle`),
    metricCard('Crossing Time', fmtYears(scn.exp.tCrossYr), `2R / v_wave, R=${fmtCount(p.R)} ly`),
    metricCard('Branching (k·s)', scn.exp.branching.toFixed(2), scn.exp.stalled ? 'stalls — front dies out' : 'sustains expansion'),
    metricCard('Habitable Planets', fmtSci(scn.lambda), ghzNote),
    metricCard('N Launched', fmtCount(scn.nLaunched), 'emerged ≤ now, by any point'),
    metricCard('N Arrived', fmtCount(scn.nArrived), 'wave should reach Earth by now'),
    metricCard('N Detectable', fmtCount(scn.nDetectable), `× P(detect)=${fmtPct(p.detect)}`),
    metricCard('Earliest Launch', scn.tEarliest !== null ? fmtGyr(scn.tEarliest) : 'none yet', 'first cumulative N≥ 1'),
    metricCard('Implied Filter', `${fmtCount(scn.filter)}×`, scn.filter <= 1.01 ? 'no extra filter needed' : 'required suppression'),
    metricCard('Saturation Ceiling', fmtSci(scn.saturationCeiling), 'systems, fully colonized'),
  ].join('');
}

function metricCard(label, value, sub) {
  return `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div></div>`;
}

function renderMcSummary(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const median = pct(0.5), p05 = pct(0.05), p95 = pct(0.95);
  const modalZero = sorted.filter(n => n < 1).length / sorted.length;
  el.mcSummary.hidden = false;
  el.mcSummary.innerHTML = `
    ${fmtCount(p.runs)} runs, seed ${p.seed}. Rarity terms sampled log-uniform each run
    (P(abiogenesis), P(intelligence) ∈ [10⁻⁹, 1]; P(launches) ∈ [0,1]); timing held fixed.<br>
    <strong>Median N arrived: ${fmtCount(median)}</strong> &nbsp;
    5th–95th percentile: ${fmtCount(p05)} – ${fmtCount(p95)} &nbsp;
    P(N &lt; 1): <strong>${fmtPct(modalZero)}</strong>
  `;
}

// ──────────────────────────────────────────────────────────────
// RUN — deterministic scenario, then (optionally) chunked Monte Carlo
// ──────────────────────────────────────────────────────────────
let activePresetId = null;

function runSimulation() {
  const p = readParams();
  p.presetId = activePresetId;
  p.presetLabel = activePresetId ? PRESETS[activePresetId].label : 'Custom scenario';
  p.blurb = activePresetId ? PRESETS[activePresetId].blurb : null;
  el.runBtn.disabled = true;
  activateTab('front');

  const scn = evaluateScenario(p);
  renderResults(scn, p);

  const pts = frontSeries(scn.exp, p, scn.saturationCeiling);
  renderFrontChart(pts, scn.exp, scn.saturationCeiling);
  renderEmergenceChart(scn.em, scn.lambda, scn.rarity, p.T, scn.exp.tCrossGyr);

  el.tabMc.hidden = !p.stoch;
  if (!p.stoch) {
    $('mc-summary').hidden = true;
    el.runBtn.disabled = false;
    updateHash(p.presetId);
    return;
  }

  // Monte Carlo — chunked across animation frames.
  el.progressWrap.hidden = false;
  el.progressFill.style.width = '0%';
  const total = p.runs;
  const rng = mulberry32(p.seed);
  const samples = new Array(total);
  const massArrived = scn.massArrived;
  let done = 0;
  const CHUNK = 500;

  function step() {
    const end = Math.min(done + CHUNK, total);
    for (let i = done; i < end; i++) {
      const fl = sampleLogUniform(rng, -9, 0);
      const fi = sampleLogUniform(rng, -9, 0);
      const fc = rng();
      samples[i] = scn.lambda * fl * fi * fc * massArrived;
    }
    done = end;
    const pct = done / total;
    el.progressFill.style.width = `${(pct * 100).toFixed(0)}%`;
    el.progressLabel.textContent = `Running Monte Carlo… ${done.toLocaleString()} / ${total.toLocaleString()}`;
    if (done < total) {
      requestAnimationFrame(step);
    } else {
      el.progressWrap.hidden = true;
      renderMcChart(samples);
      renderMcSummary(samples, p);
      el.runBtn.disabled = false;
      updateHash(p.presetId);
    }
  }
  requestAnimationFrame(step);
}

// ──────────────────────────────────────────────────────────────
// EVENT WIRING
// ──────────────────────────────────────────────────────────────
function wireEvents() {
  const liveInputs = [
    el.v, el.hopVal, el.hopUnit, el.dwell, el.k, el.fail,
    el.density, el.R, el.ghz, el.ghzIn, el.ghzOut, el.thick,
    el.T, el.tMetal, el.mu, el.sigma, el.sfr,
    el.fl, el.fi, el.fc, el.detect, el.stoch, el.runs, el.seed,
  ];
  let prevHopUnit = el.hopUnit.value;
  liveInputs.forEach(input => {
    input.addEventListener('input', () => {
      if (input === el.hopUnit) {
        // Convert displayed value so the underlying ly quantity is unchanged.
        const oldLy = parseFloat(el.hopVal.value) * LY_PER[prevHopUnit];
        el.hopVal.value = +(oldLy / LY_PER[el.hopUnit.value]).toPrecision(6);
        prevHopUnit = el.hopUnit.value;
      }
      activePresetId = null;
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      syncDerivedUI();
    });
  });

  el.runBtn.addEventListener('click', runSimulation);

  el.presets.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.preset;
      const preset = PRESETS[id];
      if (!preset) return;
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activePresetId = id;
      applyParams(preset);
      runSimulation();
    });
  });

  window.addEventListener('hashchange', () => {
    if (ignoreNextHashChange) { ignoreNextHashChange = false; return; }
    loadFromHash();
  });
}

// ──────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────
function loadFromHash() {
  const parsed = parseHash(location.hash);
  if (!parsed) return false;
  if (parsed.presetId && PRESETS[parsed.presetId]) {
    const id = parsed.presetId;
    const preset = PRESETS[id];
    const btn = el.presets.querySelector(`[data-preset="${id}"]`);
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    activePresetId = id;
    applyParams(preset);
    runSimulation();
    return true;
  }
  if (parsed.params) {
    activePresetId = null;
    applyParams(parsed.params);
    runSimulation();
    return true;
  }
  return false;
}

function wireEli5Modal() {
  const modal = $('eli5-modal');
  const openBtn = $('eli5-btn');
  const closeBtn = $('eli5-close');
  if (!modal || !openBtn) return;
  openBtn.addEventListener('click', () => modal.showModal());
  closeBtn.addEventListener('click', () => modal.close());
  // Click on the backdrop (outside .modal-card) closes it.
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });
}

function init() {
  initTabs();
  wireEvents();
  wireEli5Modal();
  syncDerivedUI();
  if (!loadFromHash()) {
    // no shareable state — leave the placeholder showing.
  }
}

init();
