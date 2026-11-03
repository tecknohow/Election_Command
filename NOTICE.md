# Notices, attributions and disclaimer

Election Command's source code is released under the MIT License (see [LICENSE](LICENSE)). The data it displays, and some bundled assets, come from third parties under their own terms, listed below. The same information appears in the app under **⚙ Settings → About**.

## Disclaimer

- **Unofficial and independent.** This is a personal project. It is not affiliated with, endorsed by, or sponsored by The New York Times, the Associated Press, CNN, Polymarket, Silver Bulletin, The Cook Political Report, Ballotpedia, the Wikimedia Foundation, the U.S. Census Bureau, or any other organization named here.
- **Not an official results source.** Results are collected automatically from third-party feeds and may be delayed, incomplete or inaccurate. Official results come only from state and local election officials and are certified after Election Day. Do not rely on this software for any decision where accuracy matters.
- **Race calls are projections** by the Associated Press (as published by The New York Times) or CNN's decision desk. They are not official declarations.
- **Forecast ratings are opinions** of their publishers (Silver Bulletin's FLIPR model and The Cook Political Report), shown as rating categories compiled on Wikipedia.
- **Prediction-market prices** from Polymarket reflect market trading. They are shown for information only. They are not probabilities guaranteed by anyone, not an endorsement of Polymarket or of wagering, and not financial advice. Prediction markets may be restricted where you live.
- **Simulated data.** The built-in simulator generates fictional results for testing. It is visible only to the site admin and is labeled SIMULATION wherever it appears. The screenshots in this repository were taken from the simulator and do not show real results.
- **No warranty.** The software is provided "as is", without warranty of any kind (see LICENSE).

## Data sources

| Data | Source | Terms / notes |
|---|---|---|
| Live results, AP race calls, expected-vote estimates, county results, poll-closing times | [The New York Times](https://www.nytimes.com/) election results pages (data from the [Associated Press](https://www.ap.org/)) | Read from the public JSON files behind the NYT results pages. These endpoints are undocumented, intended for the NYT's own pages, and may change without notice. Data © The New York Times / The Associated Press. Use is limited to personal, non-commercial viewing. |
| Candidate photos | The New York Times | © The New York Times. Loaded directly from the NYT's servers; not stored or redistributed by this project. |
| Backup results, early race calls, ballot-measure results | [CNN](https://www.cnn.com/election) | Read from the public JSON files behind CNN's results pages; undocumented and subject to change. Data © CNN. Personal, non-commercial use. |
| Forecast ratings (FLIPR, Cook), seat holders before the election, ballot-measure list, numbers and descriptions | Wikipedia contributors: [2026 Senate elections](https://en.wikipedia.org/wiki/2026_United_States_Senate_elections), [2026 gubernatorial elections](https://en.wikipedia.org/wiki/2026_United_States_gubernatorial_elections), [2026 House elections](https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_elections), [2026 House election ratings](https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_election_ratings), [2026 ballot measures](https://en.wikipedia.org/wiki/2026_United_States_ballot_measures) | Text and data licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Ballot-measure descriptions are shown as published, with attribution. The ratings themselves originate with [Silver Bulletin](https://www.natesilver.net/) and [The Cook Political Report](https://www.cookpolitical.com/). |
| Ballot-measure names and links | [Ballotpedia](https://ballotpedia.org/) | Each measure's display name is taken from the address of the Ballotpedia page that Wikipedia's ballot-measure list cites for it, and the measure links to that page (or to Wikipedia when there is no Ballotpedia page). Ballotpedia content is not copied or scraped. |
| Prediction-market odds | [Polymarket](https://polymarket.com/) public Gamma and CLOB APIs | Subject to [Polymarket's terms](https://polymarket.com/tos). Prices are read-only; this project does not trade or link accounts. |
| Headlines | RSS feeds from The New York Times, NPR, Politico, The Hill, CBS News, ABC News, NBC News, Fox News, Axios, and Google News search | Headlines and summaries © their publishers. Each item links to the original article. |

## Map data

| Asset | Source | License |
|---|---|---|
| `web/public/geo/house-districts-120.json` (House districts, 120th Congress) | U.S. Census Bureau, [TIGER/Line Shapefiles 2026](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html), simplified and projected by `scripts/build-districts.mjs` | Public domain (U.S. Government work) |
| State and county shapes | [us-atlas](https://github.com/topojson/us-atlas) by Mike Bostock, derived from U.S. Census Bureau cartographic boundary files | ISC License |

## Open-source software

Election Command is built on these open-source packages, among others (full license texts ship in each package under `node_modules/`):

| Package | License |
|---|---|
| React, React DOM, React Router, Zustand | MIT |
| Fastify, @fastify/static, @fastify/compress | MIT |
| fast-xml-parser | MIT |
| Vite, @vitejs/plugin-react, esbuild, tsx | MIT |
| d3-geo, topojson-client, topojson-server, topojson-simplify, us-atlas | ISC |
| shapefile | BSD-3-Clause |
| TypeScript | Apache-2.0 |
| Caddy (optional reverse proxy, Docker image) | Apache-2.0 |
| Node.js (Docker base image) | MIT and others |

## Trademarks

All product names, logos and brands are the property of their respective owners. They are used here only to identify the sources of data, and their use does not imply endorsement.
