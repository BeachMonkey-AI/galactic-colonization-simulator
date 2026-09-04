# Galactic Colonization Simulator

Model von Neumann probe expansion across the galaxy and the Fermi paradox timing argument.

**Live:** https://beachmonkey-ai.github.io/galactic-colonization-simulator/

## What it does

Tune probe engineering (cruise velocity, hop distance, dwell time, replication factor, failure
rate), civilization emergence timing (galaxy age, metallicity floor, biological-clock mean and
variance, star formation curve), and abiogenesis/intelligence rarity, then run the simulation to
see whether a colonization wave should already have reached Earth — and if so, why we don't see
one. The verdict layer combines both models into one of five headline states: **SATURATED**,
**MARGINAL**, **QUIET**, **DORMANT** (should be here, likely undetectable), or **STALLED** (the
replication front dies before reaching galactic scale). Seven presets each set every input and
demonstrate a different steelman of the Fermi paradox debate — click through all seven and the
argument tells itself. A stochastic mode runs up to 10,000 Monte Carlo samples of the rarity terms
from log-uniform priors (chunked across animation frames, with a progress indicator) and reports
the resulting distribution instead of a single point estimate. Every configuration round-trips
through the URL hash, so any tuned scenario is a shareable link.

## Model

vanilla — single `index.html` + `src/main.js` + `src/app.css`, Chart.js 4.4.0 from CDN, no bundler.

## Local dev

```
npm install
npm run gen-icons   # regenerates public/icons/ — gitignored, not committed
npm run build        # writes dist/
```

No dev server is bundled — open `index.html` directly, or serve `.` with any static file server.

## Token deviations

`--accent` overridden to `#a78bfa` (violet); `--bg`/`--surface`/`--border`/`--text` shifted to a
darker space palette (`#05080f` base) to match the `spaceship-simulator` sibling app's look.
