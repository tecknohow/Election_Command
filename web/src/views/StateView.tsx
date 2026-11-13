import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import type { CountyRaceResult, CountySummary, Party, Race, RaceCounties, StateRace, StateSummary } from '../../../shared/src/types';
import { STATE_BY_POSTAL, STATES } from '../../../shared/src/states';
import { PARTY_COLOR, NEUTRAL, levelColor } from '../lib/colors';
import { fmtEt, fmtNum, raceName, safeHref } from '../lib/format';
import { loadCounties, pathBounds, type CountyShape } from '../map/counties';
import { useElection } from '../store/election';

/**
 * Statewide view: every race on a state's ballot, not just Senate / governor / House. Other
 * statewide offices, the legislature and local races come from the state's NYT/AP file via
 * /api/states/:st; clicking a county opens that county's dashboard (/api/states/:st/counties/:fips).
 */

const LAST_STATE_KEY = 'ec-statewide-state';
const POLL_MS = 20_000;

function usePolled<T>(url: string | null): { data: T | null; err: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setErr(null);
    if (!url) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(r.status === 429 ? 'rate limited, retrying' : `HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (alive) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);
  return { data, err };
}

// ------------------------------------------------------------------ race rows

interface RowCand {
  name: string;
  party: Party | null;
  pct: number;
  votes: number;
  winner: boolean;
}
interface Row {
  key: string;
  title: string;
  sub?: string;
  status: string;
  statusCls: string;
  cands: RowCand[];
  counted: boolean;
  /** In-app drill-down (Senate / governor / House). */
  to?: string;
  /** NYT race page for other races. */
  href?: string | null;
}

function statusOf(called: boolean, runoff: boolean, eevp: number | null, votes: number, pollClose?: string | null): [string, string] {
  if (called) return ['✔ Called', 'status-called'];
  if (runoff) return ['Runoff', 'status-runoff'];
  if (votes > 0) return [`${Math.round(eevp ?? 0)}% in`, 'status-counting'];
  return [pollClose ? `Closes ${fmtEt(pollClose)}` : 'No votes yet', 'status-upcoming'];
}

function stateRaceRow(r: StateRace, result?: CountyRaceResult | null, pollClose?: string | null): Row {
  const total = result ? result.totalVotes : r.totalVotes;
  const cands = r.candidates.map((c) => {
    const votes = result ? (result.votes[c.id] ?? 0) : c.votes;
    return { name: c.name, party: c.party, votes, pct: total > 0 ? (votes / total) * 100 : 0, winner: c.winner };
  });
  if (result) cands.sort((a, b) => b.votes - a.votes);
  const [status, statusCls] = statusOf(r.called, r.runoff, result ? result.eevp : r.eevp, total, pollClose);
  return { key: r.id, title: r.title, sub: r.description ?? undefined, status, statusCls, cands, counted: total > 0, href: r.url };
}

function mainRaceRow(race: Race, result?: CountyRaceResult | null): Row {
  const total = result ? result.totalVotes : race.totalVotes;
  const cands = race.candidates.map((c) => {
    const votes = result ? (result.votes[c.id] ?? 0) : c.votes;
    return { name: c.name, party: c.party, votes, pct: total > 0 ? (votes / total) * 100 : 0, winner: c.winner };
  });
  if (result) cands.sort((a, b) => b.votes - a.votes);
  const [status, statusCls] = statusOf(!!race.winner, race.status === 'runoff', result ? result.eevp : race.eevp, total, race.pollClose);
  return { key: race.id, title: raceName(race) + (race.office === 'S' ? ' · Senate' : race.office === 'G' ? ' · Governor' : ''), status, statusCls, cands, counted: total > 0, to: `/race/${race.id}` };
}

function RaceRow({ row, max = 3 }: { row: Row; max?: number }) {
  const navigate = useNavigate();
  const shown = row.cands.slice(0, max);
  const title =
    row.href && !row.to ? (
      <a className="sv-row-title sv-ext" href={safeHref(row.href)} target="_blank" rel="noreferrer noopener" title="Open on nytimes.com" onClick={(e) => e.stopPropagation()}>
        {row.title}
      </a>
    ) : (
      <span className="sv-row-title">{row.title}</span>
    );
  return (
    <div className={`sv-row ${row.to ? 'link' : ''}`} onClick={row.to ? () => navigate(row.to!) : undefined}>
      <div className="sv-row-head">
        {title}
        <span className={`badge ${row.statusCls}`}>{row.status}</span>
      </div>
      {row.sub ? <div className="sv-row-sub muted small">{row.sub}</div> : null}
      {shown.map((c) => (
        <div key={c.name} className={`sv-cand ${c.winner ? 'won' : ''}`}>
          <i style={{ background: c.party ? PARTY_COLOR[c.party] : '#8a93a6' }} />
          <span className="sv-cand-name">
            {c.name}
            {c.winner ? ' ✔' : ''}
          </span>
          <span className="sv-cand-bar">
            <b style={{ width: `${Math.min(100, c.pct)}%`, background: c.party ? PARTY_COLOR[c.party] : '#8a93a6' }} />
          </span>
          <span className="num">{row.counted ? `${c.pct.toFixed(1)}%` : '—'}</span>
        </div>
      ))}
      {row.cands.length > max ? <div className="muted small">+{row.cands.length - max} more</div> : null}
    </div>
  );
}

function Panel({ title, note, children, className = '' }: { title: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {note ? <span className="muted small">{note}</span> : null}
      </div>
      <div className="sv-scroll">{children}</div>
    </section>
  );
}

function StatePicker({ st, onPick }: { st: string; onPick: (s: string) => void }) {
  return (
    <select className="sv-select" value={st} onChange={(e) => onPick(e.target.value)} aria-label="State">
      {STATES.filter((s) => s.postal !== 'DC').map((s) => (
        <option key={s.postal} value={s.postal}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ county map

type MapPick = { kind: 'main'; id: string; label: string } | { kind: 'state'; id: string; label: string };

/** Leader-margin fill, same steps as the race drill-down. */
function marginFill(votes: Record<string, number>, total: number, partyOf: (id: string) => Party | null): string {
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (!total || !ranked.length || !ranked[0][1]) return NEUTRAL.upcoming;
  const m = ((ranked[0][1] - (ranked[1]?.[1] ?? 0)) / total) * 100;
  const level = m >= 15 ? 'solid' : m >= 7 ? 'likely' : m >= 3 ? 'lean' : 'tilt';
  return levelColor(partyOf(ranked[0][0]), level);
}

function CountyMap({ st, summary, races, picked, onPick, onCounty }: { st: string; summary: StateSummary; races: Race[]; picked: MapPick | null; onPick: (p: MapPick) => void; onCounty: (fips: string) => void }) {
  const [shapes, setShapes] = useState<Map<string, CountyShape> | null>(null);
  const [hover, setHover] = useState<{ fips: string; x: number; y: number } | null>(null);
  useEffect(() => {
    void loadCounties().then(setShapes);
  }, []);
  const stFips = STATE_BY_POSTAL[st]?.fips ?? '';
  const known = useMemo(() => new Set(summary.counties.map((c) => c.fips)), [summary]);
  // Connecticut reports by planning region (extra shapes); everywhere else us-atlas counties.
  const list = useMemo(() => (shapes ? [...shapes.values()].filter((s) => s.fips.startsWith(stFips) && s.set === (st === 'CT' ? 'extra' : 'atlas') && /^\d{5}$/.test(s.fips)) : []), [shapes, stFips, st]);
  const box = useMemo(() => pathBounds(list.map((s) => s.d)), [list]);

  const options: MapPick[] = useMemo(
    () => [
      ...races.filter((r) => r.office !== 'H').map((r) => ({ kind: 'main' as const, id: r.id, label: r.office === 'S' ? `U.S. Senate${r.special ? ' (special)' : ''}` : 'Governor' })),
      ...summary.races.filter((r) => r.hasCountyResults && !r.nonpartisan && r.kind === 'statewide').map((r) => ({ kind: 'state' as const, id: r.id, label: r.title })),
    ],
    [races, summary],
  );
  const pick = picked && options.some((o) => o.id === picked.id) ? picked : (options[0] ?? null);
  const mainUrl = pick?.kind === 'main' ? `/api/races/${encodeURIComponent(pick.id)}/counties` : null;
  const stateUrl = pick?.kind === 'state' ? `/api/states/${st}/races/${encodeURIComponent(pick.id)}/counties` : null;
  const mainData = usePolled<RaceCounties>(mainUrl).data;
  const stateData = usePolled<{ units: Record<string, CountyRaceResult> }>(stateUrl).data;

  const results = useMemo((): Record<string, { votes: Record<string, number>; total: number; eevp: number | null }> => {
    if (pick?.kind === 'main' && mainData) return Object.fromEntries(mainData.units.filter((u) => u.fips).map((u) => [u.fips!, { votes: u.votes, total: u.totalVotes, eevp: u.eevp }]));
    if (pick?.kind === 'state' && stateData) return Object.fromEntries(Object.entries(stateData.units).map(([f, u]) => [f, { votes: u.votes, total: u.totalVotes, eevp: u.eevp }]));
    return {};
  }, [pick, mainData, stateData]);
  const partyOf = useMemo(() => {
    const m = new Map<string, Party | null>();
    if (pick?.kind === 'main') for (const c of races.find((r) => r.id === pick.id)?.candidates ?? []) m.set(c.id, c.party);
    if (pick?.kind === 'state') for (const c of summary.races.find((r) => r.id === pick.id)?.candidates ?? []) m.set(c.id, c.party);
    return (id: string) => m.get(id) ?? null;
  }, [pick, races, summary]);
  const nameOf = (f: string) => summary.counties.find((c) => c.fips === f)?.name ?? f;
  const h = hover ? results[hover.fips] : undefined;

  return (
    <section className="panel sv-map">
      <div className="panel-head">
        <h2>Counties</h2>
        {options.length ? (
          <select className="sv-select small" value={pick?.id ?? ''} onChange={(e) => onPick(options.find((o) => o.id === e.target.value)!)} aria-label="Color counties by">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small">no county results in this state's feed</span>
        )}
      </div>
      <div className="sv-map-body">
        {!shapes ? (
          <div className="empty">Loading map…</div>
        ) : !box ? (
          <div className="empty">No county shapes for this state.</div>
        ) : (
          <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="County map; click a county to open its dashboard">
            {list.map((s) => {
              const r = results[s.fips];
              return (
                <path
                  key={s.fips}
                  d={s.d}
                  className={`rv-county has ${hover?.fips === s.fips ? 'hl' : ''}`}
                  fill={r ? marginFill(r.votes, r.total, partyOf) : NEUTRAL.upcoming}
                  onMouseMove={(e) => setHover({ fips: s.fips, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => known.has(s.fips) && onCounty(s.fips)}
                />
              );
            })}
          </svg>
        )}
      </div>
      <div className="sw-foot small muted">Click a county for its dashboard: county and city offices, local measures, and how it voted statewide.</div>
      {hover ? (
        <div className="sw-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b>{nameOf(hover.fips)}</b>
          {h && h.total ? (
            <>
              <div className="muted">
                {pick?.label} · {Math.round(h.eevp ?? 0)}% in
              </div>
              {Object.entries(h.votes)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([id, v]) => {
                  const c = pick?.kind === 'main' ? races.find((r) => r.id === pick.id)?.candidates.find((x) => x.id === id) : summary.races.find((r) => r.id === pick?.id)?.candidates.find((x) => x.id === id);
                  const p = partyOf(id);
                  return (
                    <div key={id}>
                      <i className="party-chip" style={{ background: p ? PARTY_COLOR[p] : '#8a93a6' }} /> {c?.name ?? id} <b>{((v / h.total) * 100).toFixed(1)}%</b>
                    </div>
                  );
                })}
            </>
          ) : (
            <div className="muted">No votes yet</div>
          )}
          <div className="muted small">Click for county dashboard</div>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ state page

function LegislatureTally({ races }: { races: StateRace[] }) {
  const chambers = useMemo(() => {
    const by = new Map<string, StateRace[]>();
    for (const r of races) by.set(r.office, [...(by.get(r.office) ?? []), r]);
    return [...by.entries()].map(([office, list]) => {
      const t = { D: { won: 0, lead: 0 }, R: { won: 0, lead: 0 }, O: { won: 0, lead: 0 } };
      for (const r of list) {
        const w = r.candidates.find((c) => c.winner);
        const lead = r.totalVotes > 0 ? r.candidates[0] : null;
        const k = (p: Party | null) => (p === 'D' ? 'D' : p === 'R' ? 'R' : 'O');
        if (w) t[k(w.party)].won++;
        else if (lead) t[k(lead.party)].lead++;
      }
      return { office, n: list.length, t };
    });
  }, [races]);
  if (!chambers.length) return <div className="empty">No state legislative races in this state's feed.</div>;
  return (
    <div className="sv-leg">
      {chambers.map((c) => (
        <div key={c.office} className="sv-leg-row">
          <b>{c.office}</b>
          <span className="muted small">{c.n} seats up</span>
          {(['D', 'R', 'O'] as const).map((p) =>
            c.t[p].won || c.t[p].lead ? (
              <span key={p} className="sv-leg-count" style={{ color: p === 'O' ? undefined : PARTY_COLOR[p] }}>
                {p === 'O' ? 'Other' : p} {c.t[p].won}
                {c.t[p].lead ? <small className="muted"> +{c.t[p].lead} leading</small> : null}
              </span>
            ) : null,
          )}
        </div>
      ))}
      <div className="muted small">Won (called) seats, with seats currently led alongside.</div>
    </div>
  );
}

function StatePage({ st }: { st: string }) {
  const navigate = useNavigate();
  const allRaces = useElection((s) => s.races);
  const measures = useElection((s) => s.measures);
  const mode = useElection((s) => s.mode);
  const { data, err } = usePolled<StateSummary>(`/api/states/${st}`);
  const [picked, setPicked] = useState<MapPick | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(LAST_STATE_KEY, st);
    } catch {
      /* ignore */
    }
    setPicked(null);
  }, [st]);

  const main = useMemo(() => Object.values(allRaces).filter((r) => r.state === st), [allRaces, st]);
  const top = main.filter((r) => r.office !== 'H').sort((a, b) => a.office.localeCompare(b.office));
  const house = main.filter((r) => r.office === 'H').sort((a, b) => (a.district ?? 0) - (b.district ?? 0));
  const stMeasures = Object.values(measures).filter((m) => m.state === st);
  const races = data?.races ?? [];
  const statewide = races.filter((r) => r.kind === 'statewide');
  const legislature = races.filter((r) => r.kind === 'legislature');
  const localPlaced = races.filter((r) => (r.kind === 'local' || r.kind === 'measure') && r.counties.length);
  const regional = races.filter((r) => r.kind === 'district' || ((r.kind === 'local' || r.kind === 'measure') && !r.counties.length));
  const byCounty = useMemo(() => {
    const m = new Map<string, StateRace[]>();
    for (const r of localPlaced) for (const f of r.counties) m.set(f, [...(m.get(f) ?? []), r]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [localPlaced]);
  const countyName = (f: string) => data?.counties.find((c) => c.fips === f)?.name ?? f;
  const pollClose = main[0]?.pollClose ?? null;
  const toCounty = (f: string) => navigate(`/state/${st}/county/${f}`);

  return (
    <div className="state-view">
      <header className="panel sv-head">
        <div className="sv-head-row">
          <h1>{STATE_BY_POSTAL[st]?.name}</h1>
          <StatePicker st={st} onPick={(s) => navigate(`/state/${s}`)} />
          {data?.counties.length ? (
            <select className="sv-select" value="" onChange={(e) => e.target.value && toCounty(e.target.value)} aria-label="Open a county">
              <option value="">Open a county…</option>
              {data.counties.map((c) => (
                <option key={c.fips} value={c.fips}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : null}
          <span className="muted small sv-head-note">
            {top.length + statewide.length} statewide races · {house.length} U.S. House · {legislature.length} legislative · {localPlaced.length + regional.length} local & regional
            {pollClose ? ` · polls close ${fmtEt(pollClose)} ET` : ''}
          </span>
        </div>
        {mode === 'simulation' ? <div className="rc-note">Simulation view: Senate, governor and House are simulated; other offices and local races show live data.</div> : null}
        {err ? <div className="rc-note">Couldn't load this state's other races ({err}).</div> : data && !data.published ? <div className="rc-note">NYT/AP hasn't published this state's full results file yet; showing the races already covered.</div> : null}
      </header>

      <div className="cv-area" style={{ gridArea: 'statewide' }}>
        <Panel title="Statewide offices" note="AP calls · NYT/AP">
          {top.map((r) => (
            <RaceRow key={r.id} row={mainRaceRow(r)} />
          ))}
          {statewide.map((r) => (
            <RaceRow key={r.id} row={stateRaceRow(r, null, pollClose)} />
          ))}
          {!top.length && !statewide.length ? <div className="empty">{data ? 'No statewide races this year.' : 'Loading…'}</div> : null}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'map' }}>
        {data ? <CountyMap st={st} summary={data} races={top} picked={picked} onPick={setPicked} onCounty={toCounty} /> : <section className="panel"><div className="empty">Loading…</div></section>}
      </div>

      <div className="cv-area sv-stack" style={{ gridArea: 'side' }}>
        <Panel title="State legislature" className="sv-leg-panel">
          <LegislatureTally races={legislature} />
        </Panel>
        <Panel title="Ballot measures" note={`${stMeasures.length} statewide`}>
          {stMeasures.map((m) => (
            <div key={m.id} className="sv-row">
              <div className="sv-row-head">
                <span className="sv-row-title">
                  {m.code ? `${m.code} · ` : ''}
                  {m.title}
                </span>
                <span className={`badge ${m.result ? (m.result === 'passed' ? 'status-called' : 'status-runoff') : m.totalVotes ? 'status-counting' : 'status-upcoming'}`}>
                  {m.result ? (m.result === 'passed' ? 'Passed' : 'Failed') : m.totalVotes ? `Yes ${m.yesPct?.toFixed(1) ?? '—'}%` : 'No votes yet'}
                </span>
              </div>
            </div>
          ))}
          {!stMeasures.length ? <div className="empty">No statewide measures.</div> : null}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'house' }}>
        <Panel title="U.S. House" note={`${house.length} districts`}>
          {house.map((r) => (
            <RaceRow key={r.id} row={mainRaceRow(r)} max={2} />
          ))}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'local' }}>
        <Panel title="Local races by county" note="click a county">
          {byCounty.map(([f, list]) => (
            <button key={f} className="sv-county-btn" onClick={() => toCounty(f)}>
              <b>{countyName(f)}</b>
              <span className="muted small">
                {list.length} race{list.length > 1 ? 's' : ''}: {list.slice(0, 4).map((r) => r.title).join(' · ')}
                {list.length > 4 ? ' …' : ''}
              </span>
            </button>
          ))}
          {regional.length ? <h3 className="sv-sub">Regional & districted</h3> : null}
          {regional.map((r) => (
            <RaceRow key={r.id} row={stateRaceRow(r, null, pollClose)} max={2} />
          ))}
          {!byCounty.length && !regional.length ? <div className="empty">{data ? 'No local races in NYT/AP coverage for this state.' : 'Loading…'}</div> : null}
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ county page

function CountyPage({ st, fips }: { st: string; fips: string }) {
  const navigate = useNavigate();
  const allRaces = useElection((s) => s.races);
  const { data, err } = usePolled<CountySummary>(`/api/states/${st}/counties/${fips}`);
  const counties = usePolled<StateSummary>(`/api/states/${st}`).data?.counties ?? [];
  const main = (data?.main ?? []).map((m) => ({ race: allRaces[m.raceId], result: m.result })).filter((x) => x.race);
  const top = main.filter((x) => x.race.office !== 'H');
  const house = main.filter((x) => x.race.office === 'H').sort((a, b) => (a.race.district ?? 0) - (b.race.district ?? 0));
  const statewide = (data?.stateRaces ?? []).filter((x) => x.race.kind === 'statewide');
  const districted = (data?.stateRaces ?? []).filter((x) => x.race.kind !== 'statewide');
  const offices = (data?.local ?? []).filter((r) => r.kind === 'local');
  const measures = (data?.local ?? []).filter((r) => r.kind === 'measure');
  const pollClose = Object.values(allRaces).find((r) => r.state === st)?.pollClose ?? null;

  return (
    <div className="state-view county-view">
      <header className="panel sv-head">
        <div className="sv-head-row">
          <button className="back-btn" onClick={() => navigate(`/state/${st}`)}>
            ← {STATE_BY_POSTAL[st]?.name}
          </button>
          <h1>{data?.name ?? 'County'}</h1>
          {counties.length ? (
            <select className="sv-select" value={fips} onChange={(e) => navigate(`/state/${st}/county/${e.target.value}`)} aria-label="County">
              {counties.map((c) => (
                <option key={c.fips} value={c.fips}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : null}
          <span className="muted small sv-head-note">
            {offices.length} local offices · {measures.length} local measures · {house.length} U.S. House district{house.length === 1 ? '' : 's'}
          </span>
        </div>
        {err ? <div className="rc-note">Couldn't load this county ({err}).</div> : null}
      </header>

      <div className="cv-area" style={{ gridArea: 'statewide' }}>
        <Panel title="Statewide races here" note="this county's vote">
          {top.map((x) => (
            <RaceRow key={x.race.id} row={mainRaceRow(x.race, x.result)} />
          ))}
          {statewide.map((x) => (
            <RaceRow key={x.race.id} row={{ ...stateRaceRow(x.race, x.result, pollClose), sub: x.result ? undefined : 'Statewide result (no county breakdown in the feed)' }} />
          ))}
          {!top.length && !statewide.length ? <div className="empty">{data ? 'No county results yet.' : 'Loading…'}</div> : null}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'map' }}>
        <Panel title="County & city offices" note="NYT/AP local coverage">
          {offices.map((r) => (
            <RaceRow key={r.id} row={stateRaceRow(r, null, pollClose)} max={4} />
          ))}
          {!offices.length ? <div className="empty">{data ? 'No county or city offices in NYT/AP coverage here.' : 'Loading…'}</div> : null}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'side' }}>
        <Panel title="Local measures & referendums">
          {measures.map((r) => (
            <RaceRow key={r.id} row={stateRaceRow(r, null, pollClose)} max={2} />
          ))}
          {!measures.length ? <div className="empty">{data ? 'No local measures in NYT/AP coverage here.' : 'Loading…'}</div> : null}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'house' }}>
        <Panel title="U.S. House" note="this county's part of each district">
          {house.map((x) => (
            <RaceRow key={x.race.id} row={mainRaceRow(x.race, x.result)} max={2} />
          ))}
          {!house.length ? <div className="empty">{data ? 'No House results by county here yet.' : 'Loading…'}</div> : null}
        </Panel>
      </div>

      <div className="cv-area" style={{ gridArea: 'local' }}>
        <Panel title="Legislative & districted races" note="this county's vote">
          {districted.map((x) => (
            <RaceRow key={x.race.id} row={stateRaceRow(x.race, x.result, pollClose)} max={2} />
          ))}
          {!districted.length ? <div className="empty">{data ? 'No legislative or districted results by county in the feed.' : 'Loading…'}</div> : null}
        </Panel>
      </div>
    </div>
  );
}

/** /state → last state viewed (or California); /state/:st; /state/:st/county/:fips. */
export function StateView() {
  const { st: raw, fips } = useParams();
  const st = raw?.toUpperCase();
  if (!st || !STATE_BY_POSTAL[st] || st === 'DC') {
    let last = 'CA';
    try {
      last = localStorage.getItem(LAST_STATE_KEY) || 'CA';
    } catch {
      /* ignore */
    }
    return <Navigate to={`/state/${STATE_BY_POSTAL[last] ? last : 'CA'}`} replace />;
  }
  return fips ? <CountyPage key={`${st}-${fips}`} st={st} fips={fips} /> : <StatePage key={st} st={st} />;
}
