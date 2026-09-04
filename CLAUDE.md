# CLAUDE.md — Galactic Colonization Simulator

- **What this app does:** Models von Neumann probe expansion across the galaxy against the
  timescale for technological civilizations to emerge, and combines the two into a Fermi
  paradox verdict (SATURATED / MARGINAL / QUIET / DORMANT / STALLED). Seven presets each set
  every input and demonstrate one steelman of the paradox debate. A stochastic (Monte Carlo)
  mode samples the rarity terms from log-uniform priors instead of point estimates.
- **Live:** https://beachmonkey-ai.github.io/galactic-colonization-simulator/
- **Model:** vanilla (single index.html + src/main.js + src/app.css, CDN Chart.js, no bundler)
- **Token deviations from app-template:** `--accent` overridden to `#a78bfa` (violet), `--bg`/
  `--surface`/`--border`/`--text` shifted to match the spaceship-simulator sibling's dark-space
  palette (`#05080f` base) rather than the template's neutral gray.
- **Anything else Bob needs to know that isn't obvious from the code:**
  - The physics/probability model (`src/main.js`) is original to this app — it has no shared
    code with `spaceship-simulator`, only a matching visual shell (presets row, sticky controls
    panel, chart tabs, Physics Reference footer) and the same Chart.js version, per the PRD.
  - `LAMBDA_MAX` (total potentially-habitable planets ever formed in the galaxy, collapsed
    Drake terms R*·f_p·n_e) and the verdict thresholds (`QUIET_MAX`, `MARGINAL_MAX`) were
    numerically calibrated against a scratch test harness so all seven presets land on the
    verdict their name promises — see the PR description for the calibration notes and
    numbers. Changing `LAMBDA_MAX` shifts every preset's magnitude; re-verify all seven
    verdicts (not just the one you're touching) before changing it.
  - "Late Metallicity" ships with a metallicity floor of 11 Gyr, not the 8 Gyr used in early
    PRD flavor text — 8 Gyr wasn't numerically sufficient to reach QUIET given the default
    biological-clock mean (4.5 Gyr) and galaxy age (13.6 Gyr); see CLAUDE.md/PR notes rather
    than assuming the UI copy is wrong.
  - URL hash state: a preset click sets `#p=<id>`; any manual slider edit switches to a full
    param encoding (`#v=...&hop=...&...`). Both are parsed on load and on `hashchange`.
