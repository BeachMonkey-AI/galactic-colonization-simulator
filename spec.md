# Spec — Galactic Colonization Simulator

## What it does

Lets a user tune von Neumann probe engineering parameters (cruise velocity, hop distance, dwell
time, replication factor, failure rate), civilization emergence timing (galaxy age, metallicity
floor, biological-clock mean/variance, star formation curve), and abiogenesis/intelligence rarity
(three probability sliders), then computes whether a colonization wave should already have
reached Earth. The verdict layer combines the two models into one of five headline states:
SATURATED, MARGINAL, QUIET, DORMANT (probes should be here but likely undetectable), or STALLED
(the replication front dies out before reaching galactic scale, independent of timing). Seven
presets each set every input and demonstrate a different steelman of the Fermi paradox debate. A
stochastic mode runs up to 10,000 Monte Carlo samples of the rarity terms from log-uniform priors,
chunked across animation frames with a progress indicator, and reports the resulting distribution.
All state round-trips through the URL hash.

## Out of scope

- 3D galaxy rendering or N-body simulation.
- Account system or persistence beyond URL state.
- Published-paper-grade astrophysical fidelity — this is an educational/exploratory dashboard;
  constants like the total habitable-planet budget are order-of-magnitude, documented assumptions,
  not literature values pinned to a citation.
- A dedicated percolation-theory (Landis-style clustered stalling) model — folded into the single
  failure-rate parameter instead, per the PRD's resolved open question.

## Open questions (resolved during build)

- Percolation theory as its own model vs. a failure-rate parameter → kept as failure rate.
- Add a "detectability" layer as a fourth verdict state → yes; added `P(detect | present)` and the
  DORMANT verdict state.
- Uniform disk vs. Galactic Habitable Zone radial constraint → added as a toggleable annulus
  constraint (default on) affecting the habitable-planet budget and saturation ceiling.
