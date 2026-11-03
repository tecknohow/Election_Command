# Election Command — Architecture

## Goals that shaped the design

- **Many windows, one poller.** The app will be open full-screen on several monitors at once. Browsers never call upstream APIs; a single server polls each source once and fans updates out to every window. Opening a fifth monitor costs upstream nothing.
- **One topic per screen.** Each route is a full-screen dashboard (master dashboard, Senate map, Governor map, …), switchable with `1`–`9` (in nav order) or the top nav. Map settings live in the URL (`/map/senate?fill=market`), so each monitor can be bookmarked to a specific view.
- **Aggregators over election offices.** Results come from two news aggregators that already normalize AP / Decision Desk data for all 50 states, rather than 50 state election-night reporting sites.
- **Degrade gracefully.** Every source has independent backoff and health reporting; results fail over from NYT to CNN automatically; state is persisted so a container restart mid-night loses nothing.

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
                    │                                    /data/state.json (volume)                       │
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
| **CNN results** (secondary) | `politics.api.cnn.io/results/national-races/2026-{SG,GG,HG}.json` | Decision Desk vote counts & calls, flip flag, poll embargo times | 30s / 5 min | Public CDN, `max-age=20`, ETags. Used for failover when NYT data is >3 min stale, and to surface CNN calls before AP's. |
| **Wikipedia** | MediaWiki `action=parse` on "2026 United States Senate elections" / "…gubernatorial elections" | **FLIPR** rating (Silver Bulletin column), **Cook** rating, prior holding party, incumbent name | 30 min / 60 min | No hard limit for polite clients; descriptive User-Agent, serial requests. |
| **Polymarket Gamma** | `gamma-api.polymarket.com/public-search`, `/events?tag_slug=house-elections`, `/events?slug=…` | Locates each race's market ("{State} Senate Election Winner", "{ST}-{NN} House Election Winner") + chamber-control markets; token IDs | 30 min / 60 min | Documented ~4000 req/10s (events ~500/10s). Responses CDN-cached 5 min, so not used for live prices. |
| **Polymarket CLOB** | `POST clob.polymarket.com/midpoints` | Live midpoint price for every outcome (≈1,070 tokens incl. House) in batches of 100 | 30s / 2 min | Price endpoints ~1500 req/10s; we use ~11 requests per 30s. Falls back to Gamma's `outcomePrices`. |
| **CNN ballot measures** | `politics.api.cnn.io/results/national-races/2026-I{n}G.json` (n = 1…6, auto-discovered) | Live yes/no votes + calls for ~60 notable measures | 30s / 5 min | Same CDN as CNN results. Slots also contain measures decided at earlier 2026 elections; only those closing on Nov 3 are kept. |
| **NYT state files** | `…/2026-11-03/results-{state}.json` (`office_id: "I"`) | AP results for every statewide measure | probe every 10 / 60 min until published, then 2 min | Not yet published as of Nov 2; picked up automatically. Per-state errors are retried individually. |
| **Wikipedia measures catalog** | "2026 United States ballot measures" | Every certified measure: origin (legislature / citizens), what a yes vote does; used to classify constitutional amendments | 60 min | Matched to live measures by measure number, then text similarity within the state. |
| **Wikipedia House tables** | "2026 … House of Representatives elections" + "… election ratings" | Incumbent party for 429 districts; FLIPR + Cook for 145 competitive seats | 30 min | Seats not on the competitive list are shown as Safe for the incumbent party in the forecast view. |
| **Census TIGER/Line 2026** | `www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_{SS}_cd120.zip` | 120th-Congress district boundaries (the districts on this ballot, incl. TX/CA/MO/NC/OH/UT redraws) | build time only | `scripts/build-districts.mjs` projects with the same AlbersUSA settings as us-atlas (scale 1300, translate 487.5/305) and simplifies to 3.5% of points. |
| **News RSS** | NYT, NPR, Politico, The Hill, CBS, ABC, NBC, Fox, Axios (filtered), Google News search (filtered) | Breaking-news headlines | 90s / 5 min | Conditional GET per feed; items de-duplicated by normalized headline. Configurable via `NEWS_FEEDS`. |

**About FLIPR:** FLIPR is Nate Silver's 2026 midterm model (Silver Bulletin). Its race-level probabilities are paywalled, but its published rating categories are tracked in Wikipedia's predictions tables (the "Silver" column), which editors update daily. That column is the FLIPR source; Cook (from the same tables) is the fallback, then NYT's own rating.

**Prior control** comes from the incumbent party shading in those same Wikipedia tables, with a vetted static seed (`server/src/seed/seats.ts`) as fallback. House prior control arrives in phase 2; until then House flips rely on the provider's own flip flag.

### Polling discipline

- **Hot window** (`HOT_START`–`HOT_END`, default 3pm ET Nov 3 → 7am ET Nov 5): fast cadence. Outside it every poller drops to its cold interval automatically.
- ±10% jitter so sources don't fire in lockstep.
- Exponential backoff on failure (capped at 10 min), honouring `Retry-After`/429.
- Conditional GETs (`If-None-Match` / `If-Modified-Since`) wherever the upstream sends validators; 304s are counted in the Sources panel.

## Merge & derivation rules (ElectionStore)

1. **Race identity**: `TX-S`, `OH-G`, `CA-H-22` (at-large districts = 1).
2. **Which numbers to show**: simulator (when running) ▸ NYT if fresh (<3 min) ▸ CNN if fresher. CNN votes are mapped onto NYT's candidate list by last name + party.
3. **Calls are unioned**: if NYT/AP hasn't called a race but CNN has, the CNN call is shown (`calledBy: CNN`).
4. **Status**: `called`/`runoff` ▸ `counting` (votes > 0) ▸ `closed` (past poll-closing time) ▸ `upcoming`.
5. **Flip** = projected winner's party ≠ prior party (or the provider's own flip flag when the prior party is unknown).
6. **Chambers**: Senate counts the 65 seats not up (D 32, R 31, I 2 caucusing with D); control = D 51 / R 50 (VP Vance breaks ties). House 218. Governors: 14 not up, 26 = majority.
7. **Alerts** generated into the news feed: race calls (with HOLD/GAIN), lead changes in statewide races once ≥10% of the expected vote is in, and poll-closing waves. De-duplicated across restarts.

## Simulator (admin-only, isolated)

`POST /api/admin/sim/start {speed}` replays a compressed election night over the **real** race definitions: real candidates, poll-closing schedule, Polymarket/FLIPR expectations and 2024 baselines. Reporting curves are per state (slow West Coast counts), early-vote skew fades as the count completes, and calls happen at poll close for blowouts or once the remaining vote can't flip the race.

The simulation runs in its **own `ElectionStore` + `MeasureStore` pair**. They're seeded with a copy of the live race definitions and share the live store's forecasts and markets by reference (`adoptContext`). The SSE hub attaches a window to the sim store only when an admin session asks for `?view=sim`; every other window, and the public REST API, stays on the live store. Simulator status is scrubbed from snapshots sent to non-admins. Stopping discards the sim stores.

## Multi-user hardening

- **Admin auth:** `ADMIN_TOKEN` env (constant-time compare, 8 attempts per 15 min per IP). The session is an HMAC-signed expiry in an HttpOnly, SameSite=Strict cookie, keyed off the token, so rotating the token revokes all sessions.
- **CSRF:** admin POSTs require the session, `X-EC-Request: 1` (forces a CORS preflight cross-site, which is never approved), a JSON content type, `Sec-Fetch-Site` same-origin, and an `Origin` matching the host.
- **Headers:** strict CSP (`script-src 'self'`; images also from NYT's headshot CDN), `frame-ancestors 'none'`, `nosniff`, Referrer-Policy, COOP/CORP, Permissions-Policy, optional HSTS. API responses are `no-store`; hashed assets are immutable.
- **Untrusted content:** feed links and NYT URLs are reduced to http(s) on the server and again on the client.
- **Limits:** per-IP token-bucket rate limit on REST, live-stream caps (total and per IP), 16 KB bodies. `trustProxy` reads real client IPs behind Caddy/Cloudflare.
- **Stream efficiency:** per-connection gzip (`Z_SYNC_FLUSH` per event) and field-level patches (`diffFields`): a 1.1 MB snapshot becomes ~150 KB on the wire, and a typical race update is about 10 fields instead of 33.
- **Client resilience:** manual EventSource reopen with backoff (EventSource gives up on proxy 502s and 429s), a 45 s silence watchdog, and error boundaries per view and per desk widget.
- **Container:** non-root, read-only root filesystem, no capabilities, `no-new-privileges`, memory/PID limits, port bound to localhost; the public profile puts Caddy (automatic HTTPS) in front.
- **No user data on the server:** custom maps live in each browser's localStorage only.

## Frontend structure

```
web/src
├── main.tsx              routes + global shortcuts (1-4 views, F fullscreen)
├── store/election.ts     SSE client → Zustand (snapshot + deltas)
├── lib/colors.ts         validated party palette, rating ramps, map fill modes
├── map/                  geo (us-atlas → SVG paths), USMap, Legend
├── components/           TopBar, BalanceOfPower, RaceCard, FloatingCard, KeyRaces,
│                         NewsFeed, PollClosings, RecentCalls, SourcesPanel
└── views/                Dashboard, MapView
```

Map fill modes: **Results** (called = solid, leading = hatched, shaded by margin), **Polymarket** (implied probability bands), **FLIPR** (rating, Cook fallback), **Current** (party holding the seat before the election; governors not up shown muted), **My map**. The balance-of-power tracker follows the mode (`lib/projection.ts`): live count under Results; under Polymarket/FLIPR, solid/likely seats count as won, lean/tilt as leaning, and toss-ups as uncalled; under Current, it shows the seats each party held. Hover shows a race card; click pins/unpins it (Esc unpins). Small northeastern states get callout boxes.

## House map

District shapes are TIGER polygons, which extend into lakes and coastal water. The client clips each state's districts to that state's land outline from us-atlas with SVG `clipPath`, which also clips hit-testing. The 435-path layer is memoized separately from hover state. Zoom and pan are viewBox animations, and strokes use `vector-effect: non-scaling-stroke` so lines stay crisp at any zoom. Polymarket odds cover every district: 434 come from the `house-elections` tag and the rest from targeted search (same-party seats use "(Individual)" candidate markets, with party inferred from the race's candidate list).

## Custom maps

A small Zustand store holds `raceId → rating code` per office, saved in `localStorage` and synced across windows via the `storage` event. Share links encode one character per race in sorted-id order (`?fill=custom&my=…`) and are imported on open. The balance-of-power tracker renders a synthetic `ChamberSummary` built from the custom map.

## Ballot measures

`MeasureStore` (server) merges results NYT ▸ CNN ▸ simulator and matches each measure to the Wikipedia catalog for type and origin. It also lists catalog-only measures (no results feed yet), tags topics by keyword, applies supermajority thresholds for constitutional amendments (FL 60%, CO 55%, NH 66.7%, IL 60%), and emits PASSED/FAILED alerts. Measures travel on the same SSE stream (`measures` events).

## Chamber desks

`/senate`, `/house` and `/governors` render `ChamberView`, a fixed 4-column frame filled from `components/chamber/`. Every widget is computed client-side from the race snapshot, so no new server work was needed. `lib/odds.ts` centralizes win probability (Polymarket, falling back to the forecast rating mapped to a probability), the favorite, upset detection (leader isn't the ≥65% favorite once ≥15% of the vote is in) and potential flips (leader's party ≠ prior party). The seats timeline plots the server-recorded `bopHistory`. All widgets share one hover-card hook (`useRaceHover`).

## Drill-downs, alerts, kiosk, watchlist

- **County data**: NYT publishes `sen-county-data` and `gov-county-data` feeds (URLs discovered from the results files' page config). The House results file already carries each district's county parts. A separate `CountyStore` keeps these out of the main snapshot, and `/api/races/:id/counties` serves one race at a time; admins viewing the simulation get synthesized counties (statewide progress plus each county's 2024 lean). County shapes come from us-atlas `counties-albers-10m`, lazy-loaded as its own chunk. Alaska reports by state-house district (table only).
- **Breaking alerts** are detected client-side from live patches only (never snapshots, so reconnects don't replay). Triggers: a newly called race that is key (forecast/market-competitive), flipped, or starred, plus a chamber's `controlWinner` appearing. The chime is synthesized with Web Audio after a user gesture unlocks audio.
- **Kiosk**: per-window (sessionStorage) rotation through chosen routes after 60 s idle, paused while a banner is up.
- **Watchlist**: localStorage ids; any element with `data-race-id` opens the drill-down via one delegated click handler.

## Next ideas

- Race tables / sortable full-screen lists, BoP timeline chart (history is already recorded), county-level drill-down (NYT per-state files), House key-race list on the dashboard.
