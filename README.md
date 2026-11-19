# Token Radar: fitted comps + launch odds, held-out tested on two splits, rank ranges from refits, costed farm plans, all 758 protocols accounted for

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rsuryatna/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rsuryatna/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar, rebuilt around a fitted and validated value model. It reads a frozen
snapshot of 758 DeFi protocols and accounts for all of them: 198 pre-token protocols ranked
by implied launch value, 416 that already trade, and 144 set aside by the watchlist's own
rule, each with the reason it was set aside. The implied value is a fitted launch value
times a one-year launch odds — the launch value comes from a log-log comps curve fitted on
the snapshot's own 128 live-token protocols (TVL plus the direction of the seven-day
change), and the odds come from a Weibull-mixture survival curve fitted on every
protocol's age and whether it records a token yet. Both fits are validated on held-out
protocols the fits never saw, on three splits — a 5-fold cross-validation, a single split,
and a temporal OLD-NEW split that trains on protocols listed before 2025-01-01 and tests
on the newer ones — and the dashboard shows the validation table, including the fifteen
carry forms and the two launch-odds alternatives that were tried and dropped. Every board
row also carries a 90% rank range from 200 bootstrap refits of the fitted model, a farm
verdict (FARM / THIN / SKIP) with an expected dollar return at a $1,000 deposit, a what-if
control that recomputes the verdicts live, a "farm next" line naming the three best FARM
picks, and a six-step farm plan with costs and times. The dashboard is a static page with
a sortable, filterable board (with an "If launched" column showing the fitted value before
the odds), a detail view for every protocol, a live-token view, a set-aside view, an Export
CSV button, and a model section that shows the fitted formula, the held-out numbers, the
comps scatter with its fit line and P25–P75 band, the launch-odds curve, and the farm
sensitivity table.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=hn2e4a6b&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
