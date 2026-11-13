# Election Command — Architecture

## Goals that shaped the design

- **Many windows, one poller.** The app will be open full-screen on several monitors at once. Browsers never call upstream APIs; a single server polls each source once and fans updates out to every window. Opening a fifth monitor costs upstream nothing.
- **One topic per screen.** Each route is a full-screen dashboard (master dashboard, Senate map, Governor map, …), switchable with `1`–`9` and `0` (in nav order; `0` is the tenth view, Swing) or the top nav. Map settings live in the URL (`/map/senate?fill=market`), so each monitor can be bookmarked to a specific view; without `?fill=`, a map opens in the color mode that window last used on it (sessionStorage, per window).
- **Aggregators over election offices.** Results come from two news aggregators that already normalize AP / Decision Desk data for all 50 states, rather than 50 state election-night reporting sites.
- **Degrade gracefully.** Every source has independent backoff and health reporting; results fail over from NYT to CNN automatically; state is persisted so a container restart mid-night loses nothing, and a degraded upstream file can't overwrite saved results (see *Saved data*).

## System diagram

```
                    ┌──────────────────────── Docker container (node:22-alpine) ───────────────────────┐
                    │                                                                                    │
  NYT results JSON ─┼─► nyt poller (20s hot) ──┐                                                         │
  CNN results JSON ─┼─► cnn poller (30s hot) ──┤   ┌──────────────────────────────┐                      │
  Simulator (opt.) ─┼─► sim engine (1.5s) ─────┼──►│  ElectionStore               │   SSE /api/stream    │   ┌── Monitor 1: Dashboard
                    │                          │   │  • merge (NYT ▸ CNN failover)│──── snapshot + ──────┼──►├── Monitor 2: Senate map
  Wikipedia API ────┼─► ratings (30 min) ──────┤   │  • enrich (FLIPR/Cook/prior) │     deltas           │   ├── Monitor 3: Governor map
  Polymarket Gamma ─┼─► discovery (30 min) ────┤   │  • derive status/leader/flip │                      │   └── Monitor N: …
  Polymarket CLOB ──┼─► prices (30s) ──────────┤   │  • chamber math, alerts      │   REST /api/state    │
  11 RSS feeds ─────┼─► news (90s) ────────────┘   │  • BoP history               │   /api/health        │
                    │                              └──────────────┬───────────────┘   /api/sim/*         │
                    │                                             │ every 30s                            │
                    │                                    /data/state.json, counties.json (volume)        │
                    └────────────────────────────────────────────────────────────────────────────────────┘
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server | Node 22 + TypeScript + **Fastify** | Native `fetch`, tiny footprint, SSE via raw response; one language end to end. |
| Push | **Server-Sent Events** | One-way server→browser stream, built-in browser auto-reconnect, proxy-friendly. Every (re)connect gets a full snapshot, so clients can't drift. |
| Persistence | JSON snapshot on a Docker volume | No native deps; atomically written every 30s and on shutdown. Holds last-good source payloads, news, BoP history and alert de-dup sets. |
| Frontend | **React 18 + Vite + TypeScript**, **Zustand** store, **React Router** | Fast builds, minimal state boilerplate, URL-addressable views. |
| Map | **d3-geo** + **topojson-client** + **us-atlas** `states-albers-10m` | Pre-projected AlbersUSA geometry with AK/HI already inset in the corner; rendered as plain SVG (fast hit-testing, CSS styling). |
| Packaging | Multi-stage Dockerfile + docker-compose | Build stage compiles web + bundles server (esbuild); runtime image has only production deps and runs as `node`. |

## Data sources

| Source | Endpoint | Provides | Cadence (hot / cold) | Limits & etiquette |
|---|---|---|---|---|
| **NYT results** (primary) | `static01.nyt.com/elections-assets/pages/data/2026-11-03/results-{senate,governor,house}.json` | AP vote counts, EEVP, AP calls, candidates + incumbency + headshots, NYT ratings, poll-closing times, House control baseline, 2024 baselines | 20s (S+G), 45s (House) / 5–10 min | Public CDN (Fastly/GCS), `max-age=5`, strong ETags → conditional GET returns 304 when unchanged. House file ≈350 KB gzipped. |
| **NYT per-district House files** | `…/2026-11-03/results-{state}-us-house-{n\|at-large}.json` | County parts of one House district | one file per 4 s, only once the national House file stops carrying county parts; districts undecided or whose total has moved since their last read (called races keep counting for weeks) re-checked every 10 min, the rest every 6 h | NYT stripped county parts from the national House file around Nov 9; these files (≈740 KB each) still have them. Never fetched while the national file carries them, so election night costs nothing extra. |
| **CNN results** (secondary) | `politics.api.cnn.io/results/national-races/2026-{SG,GG,HG}.json` | Decision Desk vote counts & calls, flip flag, poll embargo times | 30s / 5 min | Public CDN, `max-age=20`, ETags. Used for failover when NYT data is stale, and to surface CNN calls before AP's. The files also keep contests decided earlier in the year for the same seat (e.g. `2026-HQ-TX-18`, the Jan 31 special runoff, already marked won), so anything whose polls closed before Nov 3 is dropped, and a seat appearing twice keeps its latest contest. |
| **Wikipedia** | MediaWiki `action=parse` on "2026 United States Senate elections" / "…gubernatorial elections" | **FLIPR** rating (Silver Bulletin column), **Cook** rating, prior holding party, incumbent name | 30 min / 60 min | No hard limit for polite clients; descriptive User-Agent, serial requests. |
| **Polymarket Gamma** | `gamma-api.polymarket.com/public-search`, `/events?tag_slug=house-elections`, `/events?slug=…` | Locates each race's market ("{State} Senate Election Winner", "{ST}-{NN} House Election Winner") + chamber-control markets; token IDs. Markets that close or resolve drop out of discovery; the store keeps their last prices, marked `closed` | 30 min / 60 min | Documented ~4000 req/10s (events ~500/10s). Responses CDN-cached 5 min, so not used for live prices. |
| **Polymarket CLOB** | `POST clob.polymarket.com/midpoints` | Live midpoint price for every outcome (≈1,070 tokens incl. House) in batches of 100 | 30s / 2 min | Price endpoints ~1500 req/10s; we use ~11 requests per 30s. Falls back to Gamma's `outcomePrices`. |
| **CNN ballot measures** | `politics.api.cnn.io/results/national-races/2026-I{n}G.json` (n = 1…6, auto-discovered) | Live yes/no votes + calls for ~60 notable measures | 30s / 5 min | Same CDN as CNN results. Slots also contain measures decided at earlier 2026 elections; only those closing on Nov 3 are kept. |
| **NYT state files** | `…/2026-11-03/results-{state}.json` (all 50 states) | AP results for every statewide measure, plus everything else on the ballot for the Statewide view: other statewide offices, state legislature, regional boards, and the local offices and measures AP covers | probe every 10 / 60 min until published, then 2 / 15 min | Published on election morning. The same files carry city and county measures (`coverage: "county"`, `office: "Local Measure"`); only `coverage: "state"` is kept. Per-state errors are retried individually. |
| **Wikipedia measures catalog** | "2026 United States ballot measures" | Every certified measure: origin (legislature / citizens), what a yes vote does, official number, and the Ballotpedia page each row cites | 60 min | Display names come from the cited Ballotpedia URL slug (Ballotpedia blocks automated access and isn't fetched); citations pointing at another state, number or subject are ignored, and a URL cited by two rows stays with the better match. Numbers missing from a row are looked up from the title of the Wikipedia article it links to. Local measures listed on the page (e.g. Buffalo charter amendments) are excluded. Matched to live measures by number, then text similarity, then by elimination when a state has exactly one unmatched measure on each side. Measures with no Ballotpedia page link to their Wikipedia article or the state's section of the list. |
| **Wikipedia House tables** | "2026 … House of Representatives elections" + "… election ratings" | Incumbent party for 429 districts; FLIPR + Cook for 145 competitive seats | 30 min | Seats not on the competitive list are shown as Safe for the incumbent party in the forecast view. |
| **Census TIGER/Line 2026** | `www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_{SS}_cd120.zip` | 120th-Congress district boundaries (the districts on this ballot, incl. TX/CA/NC/OH/UT redraws). Missouri uses cd119 (TIGER2024): its 2025 map is in cd120 but was used only in the primaries; the general ran on the 2023 lines (`scripts/district-lines.mjs`) | build time only | `scripts/build-districts.mjs` projects with the same AlbersUSA settings as us-atlas (scale 1300, translate 487.5/305) and simplifies to 3.5% of points. |
| **Census cartographic boundaries 2024** | `GENZ2024/shp/cb_2024_us_county_5m.zip`, `cb_2024_02_sldl_500k.zip` | Connecticut's 9 planning regions (its county-equivalents since 2022) and Alaska's 40 state house districts, the units AP reports by there; us-atlas predates both | build time only | `scripts/build-units.mjs` → `web/public/geo/extra-units.json`, same projection. |
| **CNN past results** | `…/national-races/{2020,2022,2024}-SG.json`, `{2022,2024}-GG`, `{2022,2024}-HG`, `2024-PG` | Previous result for every 2026 seat, House and presidential vote totals, 2024 president by state | build time only | `scripts/build-history.mjs` → `shared/src/history.json` (committed). See *Past results & swing* below. |
| **News RSS** | NYT, NPR, Politico, The Hill, CBS, ABC, NBC, Fox, Axios (filtered), Google News search (filtered), Google News election-day issues search (issue-filtered) | Breaking-news headlines | 90s / 5 min | Conditional GET per feed; items de-duplicated by normalized headline, within a poll as well as against stored items (the same story often arrives from its publisher and from Google News in one poll). Configurable via `NEWS_FEEDS`. |

**About FLIPR:** FLIPR is Nate Silver's 2026 midterm model (Silver Bulletin). Its race-level probabilities are paywalled, but its published rating categories are tracked in Wikipedia's predictions tables (the "Silver" column), which editors update daily. That column is the FLIPR source; Cook (from the same tables) is the fallback, then NYT's own rating.

**Prior control** comes from the incumbent party shading in those same Wikipedia tables, with a vetted static seed (`server/src/seed/seats.ts`) as fallback. House prior control comes from the incumbent party in the House elections tables (429 districts), with the provider's own flip flag for the rest.

### Polling discipline

- **Hot window** (`HOT_START`–`HOT_END`, default 3pm ET Nov 3 → 7am ET Nov 5): fast cadence. Outside it every poller drops to its cold interval automatically.
- ±10% jitter so sources don't fire in lockstep.
- Exponential backoff on failure (capped at 10 min), honouring `Retry-After`/429.
- Conditional GETs (`If-None-Match` / `If-Modified-Since`) wherever the upstream sends validators; 304s are counted in the Sources panel.

## Merge & derivation rules (ElectionStore)

1. **Race identity**: `TX-S`, `OH-G`, `CA-H-22` (at-large districts = 1).
2. **Which numbers to show**: simulator (when running) ▸ NYT if fresh ▸ CNN if fresher. NYT counts as stale after `STALE_AFTER_S` (3 min) or two missed NYT polls, whichever is longer, so the 5–10 minute cold-window cadence doesn't flip races to CNN between polls. CNN votes are mapped onto NYT's candidate list by last name + party.
3. **Calls are unioned**: if NYT/AP hasn't called a race but CNN has, the CNN call is shown (`calledBy: CNN`).
4. **Status**: `called`/`runoff` ▸ `counting` (votes > 0) ▸ `closed` (past poll-closing time) ▸ `upcoming`.
5. **Flip** = projected winner's party ≠ prior party (or the provider's own flip flag when the prior party is unknown).
   **Projected winner** (`Race.projected`, summed into `ChamberSummary.expected`): the call; else NYT's live model (`nyt_model_estimates.margin_quantile`, the projected final margin of the current leader; a negative median hands the race to the runner-up), which NYT publishes for House and Senate races once votes are counted; else the Polymarket favorite; else the FLIPR/Cook rating; else the current leader.
   **Poll closings** dated before election-day noon ET are moved a day later (NYT dates Alaska's 05:00Z close on Nov 3, which sorted it first).
6. **Chambers**: Senate counts the 65 seats not up (D 32, R 31, I 2 caucusing with D); control = D 51 / R 50 (VP Vance breaks ties). House 218. Governors: 14 not up, 26 = majority.
7. **Alerts** generated into the news feed: race calls (with HOLD/GAIN), lead changes in statewide races once ≥10% of the expected vote is in, and poll-closing waves. De-duplicated across restarts.

## Saved data

`store/persist.ts` keeps three files in `DATA_DIR`: `state.json` (every provider's race inputs, enrichment, markets, poll closings, news, seats history, alert de-duplication, measure inputs and catalog; written every 30 s and on SIGTERM/SIGINT), `counties.json` (`CountyStore`) and `statewide.json` (`StateRaceStore`), the last two written only when changed. Writes go to a `.tmp` file then rename, so a crash mid-write never leaves a half file.

- **Startup**: before anything is read, each file is gzip-copied to `backups/` (`state-<ISO time>.json.gz`, …); the same runs hourly (`BACKUP_INTERVAL_MIN`), keeping the newest `BACKUP_KEEP` (48) per file. A file that fails to parse is renamed `<name>.unreadable-<time>` and the server starts without it; one that can't be read at all (permissions) is never written over.
- **Upstream guards** (`lib/guard.ts`), so a partial or stripped file can't overwrite good data: a provider batch, NYT measure list or state file listing under half the entries it had (with at least 10 before) is ignored, which also leaves that feed stale so CNN takes over. After election night (`HOT_END`, the "archive phase"), a race or measure that drops out of a file, or whose count goes to zero, keeps its last input, and a county refresh with no units or under half the votes is ignored. During the night upstream is trusted as-is, since test data is zeroed before polls close.
- **Results lock** (`ElectionStore.resultsGate()`): every count keeps updating until the state certifies it. NYT's race files carry a per-race `certified` flag (`Race.certified`, shown as a badge on race pages); the results pollers (NYT, CNN, Polymarket; marked `results: true`) stop only when every race is certified, or at `RESULTS_LOCK_AT` (default noon ET Jan 3, 2027, when the new Congress is sworn in and results can no longer change), whichever comes first. Once locked, NYT's saved results are treated as never stale. Until then, after election night, those pollers' Sources-panel detail shows certification progress ("23/506 races certified"). The NYT state-file poller (measures, Statewide), Wikipedia and news are never stopped.
- Simulation data (`sim` provider, sim news) is never saved.

## Simulator (admin-only, isolated)

`POST /api/admin/sim/start {speed}` replays a compressed election night over the **real** race definitions: real candidates, poll-closing schedule, Polymarket/FLIPR expectations and 2024 baselines. Reporting curves are per state (slow West Coast counts), early-vote skew fades as the count completes, and calls happen at poll close for blowouts or once the remaining vote can't flip the race.

The simulation runs in its **own `ElectionStore` + `MeasureStore` pair**. They're seeded with a copy of the live race definitions and share the live store's forecasts and markets by reference (`adoptContext`). The SSE hub attaches a window to the sim store only when an admin session asks for `?view=sim`; every other window, and the public REST API, stays on the live store. Simulator status is scrubbed from snapshots sent to non-admins. Stopping discards the sim stores. `POST /api/admin/sim/pause {paused}` freezes simulated time (no ticks run); resuming re-anchors the clock so it continues from the paused moment, and a speed change while paused keeps it paused.

## Multi-user hardening

- **Admin auth:** `ADMIN_TOKEN` env (constant-time compare, 8 attempts per 15 min per IP). The session is an HMAC-signed expiry in an HttpOnly, SameSite=Strict cookie, keyed off the token, so rotating the token revokes all sessions.
- **CSRF:** admin POSTs require the session, `X-EC-Request: 1` (forces a CORS preflight cross-site, which is never approved), a JSON content type, `Sec-Fetch-Site` same-origin, and an `Origin` matching the host.
- **Headers:** strict CSP (`script-src 'self'`; images also from NYT's headshot CDN; `CSP_SCRIPT_SRC_EXTRA` / `CSP_CONNECT_SRC_EXTRA` add https origins for add-ons a proxy injects, such as Cloudflare Web Analytics), `frame-ancestors 'none'`, `nosniff`, Referrer-Policy, COOP/CORP, Permissions-Policy, optional HSTS. API responses are `no-store`; hashed assets are immutable.
- **Static files:** a missing file (any path with an extension, e.g. `/assets/index-<hash>.js`) is a 404, never the SPA page. `@fastify/static` lists files at startup, so a new build swapped in without a restart would otherwise serve `index.html` as a script and blank the page; always restart after a build.
- **Untrusted content:** feed links and NYT URLs are reduced to http(s) on the server and again on the client.
- **Limits:** per-IP token-bucket rate limit on REST, live-stream caps (total and per IP), 16 KB bodies. `trustProxy` reads real client IPs behind Caddy/Cloudflare.
- **Stream efficiency:** per-connection gzip (`Z_SYNC_FLUSH` per event) and field-level patches (`diffFields`): a 1.1 MB snapshot becomes ~150 KB on the wire, and a typical race update is about 10 fields instead of 33.
- **Client resilience:** manual EventSource reopen with backoff (EventSource gives up on proxy 502s and 429s), a 45 s silence watchdog, and error boundaries per view and per desk widget. The stream closes on `pagehide` and reopens on a back/forward-cache restore; otherwise each page left for another URL keeps its stream open in the cache, and six full page loads exhaust the browser's per-host HTTP/1.1 connections.
- **Container:** non-root, read-only root filesystem, no capabilities, `no-new-privileges`, memory/PID limits, port bound to localhost; the public profile puts Caddy (automatic HTTPS) in front.
- **No user data on the server:** custom maps live in each browser's localStorage only.

## Frontend structure

```
web/src
├── main.tsx              routes + global shortcuts (1-9 and 0 views, F fullscreen)
├── store/election.ts     SSE client → Zustand (snapshot + deltas), admin/sim actions
├── lib/                  colors (validated palette, fill modes), projection (BoP per map mode),
│                         odds, history (past results, 2024 baselines), swing (swing math),
│                         prefs, watchlist, customMap, sound, format
├── map/                  geo (us-atlas → SVG paths), counties (us-atlas + CT/AK extra units)
├── components/           TopBar, BalanceOfPower, RaceCard, PrevResults, FloatingCard, NewsFeed,
│   │                     KeyRaces, PollClosings, RecentCalls, SourcesPanel, Watch, Kiosk, …
│   └── chamber/          desk widgets: Hemicycle, SeatLadder, RaceTable, TileMap, …
└── views/                Dashboard, MyRacesView, ChamberView, MapView, BallotView, SwingView, RaceView
shared/src                types, states, ratings, issues (election-day trouble matcher), history.json
```

Map fill modes: **Results** (called = solid, leading = hatched, shaded by margin), **Polymarket** (implied probability bands), **FLIPR** (rating, Cook fallback), **Current** (party holding the seat before the election; governors not up shown muted), **My map**. The balance-of-power tracker follows the mode (`lib/projection.ts`): under Results the big numbers are seats secured (called + not up) and the small line is the expected total (secured + each uncalled race's projected winner, from `ChamberSummary.expected`); under Polymarket/FLIPR, solid/likely seats count as won, lean/tilt as leaning, and toss-ups as uncalled; under Current, it shows the seats each party held. Hover shows a race card; click pins/unpins it (Esc unpins). Small northeastern states get callout boxes.

## House map

District shapes are TIGER polygons, which extend into lakes and coastal water. The client clips each state's districts to that state's land outline from us-atlas with SVG `clipPath`, which also clips hit-testing. The 435-path layer is memoized separately from hover state. Zoom and pan are viewBox animations, and strokes use `vector-effect: non-scaling-stroke` so lines stay crisp at any zoom. Polymarket odds cover every district: 434 come from the `house-elections` tag and the rest from targeted search (same-party seats use "(Individual)" candidate markets, with party inferred from the race's candidate list).

## Custom maps

A small Zustand store holds `raceId → rating code` per office, saved in `localStorage` and synced across windows via the `storage` event. Share links encode one character per race in sorted-id order (`?fill=custom&my=…`) and are imported on open. The balance-of-power tracker renders a synthetic `ChamberSummary` built from the custom map.

## Ballot measures

`MeasureStore` (server) merges results NYT ▸ CNN ▸ simulator and matches each measure to the Wikipedia catalog for type and origin. It also lists catalog-only measures (no results feed yet), tags topics by keyword, applies supermajority thresholds for constitutional amendments (FL 60%, CO 55%, NH 66.7%, IL 60%), and emits PASSED/FAILED alerts. Measures travel on the same SSE stream (`measures` events).

## Chamber desks

`/senate`, `/house` and `/governors` render `ChamberView`, a fixed 4-column frame filled from `components/chamber/`. Every widget is computed client-side from the race snapshot, so no new server work was needed. `lib/odds.ts` centralizes win probability (Polymarket, falling back to the forecast rating mapped to a probability), the favorite, upset detection (leader isn't the ≥65% favorite once ≥15% of the vote is in) and potential flips (leader's party ≠ prior party). The seats timeline plots the server-recorded `bopHistory`; each point stores both expected seats (`ChamberSummary.expected`) and `called` seats (not up + won), and the timeline draws the called counts (older points without them are skipped). Widgets that report counts use called races, with leads shown separately: the balance-of-power numbers, net flips, "Seats changing hands", and State delegations ("Now" and its change count called seats only, with the uncalled seats noted). Visual widgets (hemicycle, seat ladder, tile map) draw called and leading races in distinct styles; flipped seats carry a dashed white outline and a white dot on the seat ladder, the tile map and the Senate/Governor maps (every mode but My map). All widgets share one hover-card hook (`useRaceHover`).

## Drill-downs, alerts, kiosk, watchlist

- **County data**: NYT publishes `sen-county-data` and `gov-county-data` feeds (URLs discovered from the results files' page config). The House results file carried each district's county parts through election night; once NYT strips them, the `nyt-house-districts` poller reads the per-district files instead. Those files report New England districts by town only, so towns are summed into counties (Connecticut: planning regions, via the town lookup in `server/src/geo/places.ts`), with each county's EEVP and 2024 margin weighted by town size; ward units (subsets of towns) are dropped. County results are saved to `/data/counties.json` (written with the main state when changed) so a restart keeps them even after an upstream drops them. Each race's units carry NYT's comparison margin, preferring the 2024 presidential race; where NYT offers only the seat's 2024 House race (Missouri), `RaceCounties.baseline` says so and the drill-down labels it "2024 House". A separate `CountyStore` keeps these out of the main snapshot, and `/api/races/:id/counties` serves one race at a time; admins viewing the simulation get synthesized counties (statewide progress plus each county's 2024 lean). County shapes come from us-atlas `counties-albers-10m`, lazy-loaded as its own chunk, plus `extra-units.json` for Connecticut's planning regions (FIPS 091x0) and Alaska's state house districts (key `02HD001`…); a state's map uses whichever set its units belong to. House files also list city, "rest of county" and ward units (Chicago, Detroit, Kansas City, Hartford, Bridgeport, Waterbury) that are subsets of counties also listed; those are dropped so votes aren't counted twice, while units with no county code ("Overseas absentee") stay.
- **Breaking alerts** are detected client-side from live patches only (never snapshots, so reconnects don't replay). Triggers: a newly called race that is key (rated Lean or closer, Polymarket favorite under 85%, or a close count; plus an always-key list in `KeyRaces.tsx`: GA, FL, NC and MS Senate, NH Governor), flipped, or starred, plus a chamber's `controlWinner` appearing. The chime is synthesized with Web Audio after a user gesture unlocks audio.
- **Kiosk**: per-window (sessionStorage) rotation through chosen routes after 60 s idle, paused while a banner is up.
- **Watchlist**: localStorage ids; any element with `data-race-id` opens the drill-down via one delegated click handler.

## Statewide & county dashboards

`StateRaceStore` (`server/src/store/stateRaces.ts`) is fed by the same poller that reads the NYT state files for ballot measures, so it adds no upstream requests. Races the main store already covers (Senate, Governor, House, statewide measures) are skipped; the rest are classified by `office_id` and `coverage`: `statewide`, `legislature` (SH/SS), `district` (multi-county boards), `local`, and local `measure`s. County results are kept where NYT breaks a race down by county (e.g. California's attorney general, Georgia's down-ballot offices).

Local races arrive as one statewide total with the jurisdiction only in text ("Los Angeles", "Fresno District 1", "Fresno-S - …", "Austin A - …"). They're placed in counties by matching that name against Census incorporated places and counties (`server/src/geo/places.json`, built by `scripts/build-places.mjs`): county offices (sheriff, district attorney, supervisors…) look for a county first, everything else for a city, with a unique-prefix fallback ("Lexington" → Lexington-Fayette). A place in several counties is listed in each (Chicago: Cook and DuPage; Austin: four counties). New York City's charter questions, which don't name the city, are assigned to its five boroughs. Connecticut uses its 2022 planning regions (from the 2024 Census county subdivisions) because AP reports by region. Across all 50 states this places every local measure and 92% of local offices; the rest are genuinely regional (transit districts, judicial districts, district school boards) and are listed as regional on the state page.

REST only, not the live stream: `/api/states/:st` (summary), `/api/states/:st/counties/:fips` (one county: its statewide results, local races, and Senate/Governor/House results from `CountyStore`), and `/api/states/:st/races/:id/counties` (one race by county, for the state map). The client polls them every 20 s while the view is open. Other offices and local races aren't simulated; in the admin simulation view they show live data.

## Past results & swing

`shared/src/history.json` is generated once by `scripts/build-history.mjs` and committed; nothing is fetched at runtime.

- **Previous result per seat.** House: the 2024 House race. Governor: the most recent governor's race (2022, or 2024 for NH and VT). Senate: matched by **seat class**, never by state alone. CNN types its contests `SG` (that year's regular class: 2 in 2020, 3 in 2022, 1 in 2024), `SW` (its runoff), `SP` (a same-class lame-duck special, skipped) and `S2G`/`S2W` (the state's other seat). So Georgia's class-2 seat uses the Jan 2021 runoff, Oklahoma's the 2022 special, Nebraska's the 2024 special (not the 2024 regular for the other seat), and the Ohio and Florida specials use 2022.
- **Margins** are D minus R over CNN's `totalVote` (its candidate lists omit minor candidates). Contests that weren't D vs R (same-party top-two, unopposed) are labeled and never used as a baseline.
- **Redrawn districts** are found by comparing each district's land area in TIGER cd119 (2024) and cd120 (2026): 136 changed, in AL, CA, FL, LA, NC, OH, TN, TX and UT. Their 2024 House result is shown as "old lines" and not compared. States in `scripts/district-lines.mjs` (Missouri) are skipped: their cd120 map wasn't used in the general. NYT confirms this per district: it compares redrawn districts with the 2024 presidential race and unchanged ones with their own 2024 House race.
- **2024 presidential margin by district** comes from NYT's comparison data. NYT has none for Missouri, so those eight come from each district's Wikipedia article (its statewide-results table, from Dave's Redistricting), in whole percents (`pres2024.approxByRace`).
- **2024 presidential margin within today's boundaries** comes from NYT's comparison data in the 2026 results files (Missouri's new map isn't covered yet).
- **County baselines for Senate and governor drill-downs** (`web/public/baselines/county-history.json`, loaded only by race pages): CNN's `county-races/{ecKey}.json` for each seat's previous contest, as a D-minus-R margin per county, so the drill-down's shift, baseline map, outstanding-vote lean and county table compare against the same seat rather than the 2024 presidential race. New England reports by town (CNN 8-digit town codes); towns are rolled up to counties via Census county subdivisions (`cb_2024_{SS}_cousub_500k`; for Connecticut that yields the planning regions directly), with a few spelling aliases and Maine's "{County} Cty Townships" groups; under 2% of Maine's vote stays unmatched. Illinois also lists Chicago and suburban Cook separately from Cook County, so those duplicates are skipped. Alaska is mapped only for contests on today's state house districts (the 2022 governor's race), so Alaska's Senate race, last held in 2020 on the old lines, and Arkansas's (no Democrat in 2020) keep the 2024 presidential baseline, labeled "2024 pres". House drill-downs always use the 2024 presidential margin.
- **Midterm history** (1994–2022): seat changes and House vote shares from Wikipedia election infoboxes; each midterm's swing is measured against the House vote two years earlier.

The Swing view (`lib/swing.ts`) shows raw national totals, but leads with **like-for-like** shifts: each race against its own baseline, vote-weighted, once ≥50% is counted, so partial counts don't bias it. Its scatter, state map and table each switch between House, Senate and Governor. Seat change is **net flips**: seats won that another party held, minus the reverse. The tile counts called races only, with the projected figure (`Race.projected`) underneath. The midterm-history chart's 2026 row is the one deliberate projection (called + projected winners, labeled "proj."), because it sits beside past midterms' final results.

**Independents in margins and shifts** (`sides()` in `lib/history.ts`): a race's D-minus-R margin compares its top Democrat and top Republican, except when an independent is in the top two or stands in for a missing party (AK at-large, NE/ID/SD Senate, CA-6). Then the independent takes the side of the party they're reported to caucus with (`KNOWN_CAUCUS`), else the side opposite the major-party candidate they face, so a minor third-place nominee doesn't set the margin. County shifts on race pages use the same pair, and the page notes which side the independent was counted on. `build-history.mjs` applies the same rule to past results (`indep` on a PrevResult; e.g. MA-1 and MA-2 in 2024) and to the county baselines.

## Election-day issues

`shared/src/issues.ts` is one matcher for election-administration trouble: lawsuits and court orders, extended hours, machine, scanner and poll-book failures, ballot shortages, long lines, closures and evacuations, threats, intimidation, misinformation, recounts. The server uses it to keep only matching stories from a dedicated Google News search; the client uses it for the live feed's **Voting issues** filter and ISSUE tag. Ordinary closing-time stories ("when each polling site closes") don't match.
