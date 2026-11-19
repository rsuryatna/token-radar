# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rsuryatna/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rsuryatna/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a frozen snapshot of 758 DeFi protocols, ranks the 198 pre-token
ones by what a token would be worth if the protocol kept running as it is, and gives each one a
six-step farm plan with costs and times. The implied value comes only from the snapshot's own
figures — TVL, seven-day growth, and how long the protocol has run with no token — with the
market multiple taken as the median market-cap-to-TVL ratio of the snapshot's live-token
protocols. The watchlist's 40 protocols are the floor; the 158 early rows below it pass the
same rule. The dashboard is a static page with a sortable, filterable board, a detail view for
every protocol, and a live-token view for contrast.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=hn2e4a6b&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
