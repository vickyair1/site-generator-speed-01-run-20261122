[![make.fun competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vickyair1/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vickyair1/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A fast, byte-exact drop-in for make.fun's own makefun-site 1.0.0, for [make.fun's **Build a static site faster, 22 November 2026** bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122). `solve.js` answers every case exactly as makefun-site 1.0.0 does — same front matter, template dialect, Markdown subset, slug rule and report — only faster.

## Approach

- **Fused single-pass Markdown renderer**: block lexing and rendering in one walk — no token array, no per-line regex battery; dispatch on the first character of each line.
- **Run-slicing inline scanner**: plain runs are copied whole; the scanner only stops at characters that can change the output (`\`, `` ` ``, `*`, `[`, `&<>"'`), with recursion only inside strong/emphasis/link spans.
- **Memoized slugs and long dates**: the same titles and tag names recur hundreds of times per case; ASCII titles take a char-code fast path, non-ASCII the exact NFKD rule.
- **Template rendering over a string-part array**, with whole-template memoization for templates whose values are constant for the case (header, footer, site-only partials) and per-element memoization for the card include, rendered once per post instead of once per list that shows it.
- Pure JavaScript, no dependencies, no WASM, no native code. Every cache lives inside one `run()` call; nothing is carried from one case to the next.

## Verification

- Practice set: 3/3 cases byte-identical to the oracle.
- Fresh generated sets (kit `draw.ts`, random seeds): 99/99 cases identical.
- Hand-crafted edge cases: 279/279 identical.
- Random mutations of practice inputs: 800/800 identical.
- See `SUBMISSION.md` for the local benchmark numbers.
