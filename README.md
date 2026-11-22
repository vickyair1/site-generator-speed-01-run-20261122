[![make.fun competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vickyair1/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vickyair1/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01 — a faster makefun-site drop-in

A fast, byte-exact drop-in for make.fun's own makefun-site 1.0.0, for [make.fun's **Build a static site faster, 22 November 2026** bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122). `solve.js` answers every case exactly as makefun-site 1.0.0 does — same front matter, template dialect, Markdown subset, slug rule and report — at ~4.9x the speed of the reference on `run()` (warm) and ~2.2x faster whole-program net of the null control, measured locally on the practice set.

## How it is fast

- **Run-slicing inline Markdown scanner** — plain runs are appended whole; work happens only at special characters, found with one native regex scan. Nested spans recurse on string ranges, never on sliced copies.
- **Char-dispatch block lexer** — each line is classified by its first character instead of running eight regexes per line.
- **Memoized slugs and dates** — titles respell, tag names and headings repeat; `slugify` has an ASCII fast path (ASCII is NFKD-stable) plus a per-case cache.
- **Memoized static template fragments** — templates that read only `site`/`tags`/`recent` (header, footer, nav) are rendered once per case and reused for every page.
- **Per-post card renders** — a post's card HTML is rendered once and reused across index pages and tag pages (a `{% for %}` body that is a single include of a loop-var-only template is cached per element).
- **No per-character escaping** — bulk text goes through one native `String.replace`; word counting is a single allocation-free scan.
- Pure JavaScript, no WebAssembly, no native addon, no prebuilt binary. Nothing is cached from one case to the next.

## Files

- `solve.js` — the entry: `run(input)` returns makefun-site's answer for one case.
- `main.ts` — the house driver, unchanged: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` parses as ESM.
- `LICENSE` — MIT.

## Verification

- Practice set: 3/3 cases byte-identical to the oracle (`practice/reference/expected.json`).
- 32 freshly drawn case sets from the kit generator (96 cases): 96/96 identical.
- 185 hand-crafted edge cases (front matter, Markdown, templates, slug collisions, shadowed statics, deep includes): 185/185 identical.
- 400 random mutations of practice inputs: 400/400 identical.
- Kit checker (`makefun check`): 5 passed, 0 failed; 41,916 bytes total, within the 4 MiB cap.

## Local benchmarks (this VM, node 24, fresh processes, practice set)

| | whole program | net of null control | `run()` warm | `run()` cold |
|---|---|---|---|---|
| makefun-site (baseline) | 1,516 ms | ~1,273 ms | 671 ms | 1,095 ms |
| this entry | 828 ms | ~585 ms | 138 ms | 299 ms |

Leaderboard snapshot at build time (23 Nov 03:36 WIB, dev phase, 172 entries): rank 1 at 570,000 µs, rank 3 at 840,000 µs, rank 10 at 1,210,000 µs, rank 100 at 1,630,000 µs. The entry's ratio to the baseline (~0.46x) projects it around the rank-3 bar — a credible top-10 contender, with rank 1 needing roughly a further 1.5x net.
