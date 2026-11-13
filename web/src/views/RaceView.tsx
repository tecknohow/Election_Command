import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { Candidate, CountyUnit, Party, Race, RaceCounties, RatingLevel } from '../../../shared/src/types';
import { STATE_BY_POSTAL } from '../../../shared/src/states';
import { marginToLevel } from '../../../shared/src/ratings';
import { FloatingCard } from '../components/FloatingCard';
import { WatchStar } from '../components/Watch';
import { NEUTRAL, PARTY_COLOR, RAMP, forecastFor, levelColor } from '../lib/colors';
import { fmtEt, fmtNum, fmtProb, raceName, statusText } from '../lib/format';
import { PrevResults } from '../components/PrevResults';
import { sides } from '../lib/history';
import { loadCounties, pathBounds, type CountyShape } from '../map/counties';
import { loadDistricts } from '../map/geo';
import { useElection, wantsSimView } from '../store/election';

type Mode = 'margin' | 'swing' | 'counted' | 'baseline';

/** County-level results of each Senate / governor seat's previous contest (scripts/build-history.mjs). */
interface CountyHistory {
  races: Record<string, { label: string; units: Record<string, number> }>;
}
let countyHistoryPromise: Promise<CountyHistory | null> | null = null;
function loadCountyHistory(): Promise<CountyHistory | null> {
  countyHistoryPromise ??= fetch('/baselines/county-history.json')
    .then((r) => (r.ok ? (r.json() as Promise<CountyHistory>) : null))
    .catch(() => {
      countyHistoryPromise = null;
      return null;
    });
  return countyHistoryPromise;
}

/** What each county is compared against: the seat's last race when county data exists, else 2024 president. */
interface Baseline {
  /** "2020", "2021 runoff", "2024". */
  year: string;
  /** "'20" for compact labels. */
  short: string;
  /** "2020 Senate race", "2024 presidential race". */
  name: string;
}
const PRES_BASELINE: Baseline = { year: '2024 pres', short: "'24", name: '2024 presidential race' };
/** Districts on unchanged lines (e.g. Missouri): NYT compares each county part with the seat's 2024 House race. */
const HOUSE24_BASELINE: Baseline = { year: '2024 House', short: "'24 H", name: '2024 House race' };

const MODES: { id: Mode; label: string }[] = [
  { id: 'margin', label: 'Current margin' },
  { id: 'swing', label: 'Shift vs 2024' },
  { id: 'counted', label: '% counted' },
  { id: 'baseline', label: '2024 result' },
];
const COUNT_RAMP = ['#232a38', '#313b51', '#45516c', '#5d6b8b', '#8090b2'];
const OFFICE_TITLE = { S: 'U.S. Senate', G: 'Governor', H: 'U.S. House' } as const;

interface UnitStats {
  u: CountyUnit;
  leader: Candidate | null;
  margin: number;
  /** D minus R margin (main D vs main R candidates), pct points. */
  dMargin: number | null;
  swing: number | null;
  outstanding: number;
}

function stats(u: CountyUnit, race: Race, d?: Candidate, r?: Candidate): UnitStats {
  const ranked = race.candidates.map((c) => ({ c, v: u.votes[c.id] ?? 0 })).sort((a, b) => b.v - a.v);
  const total = u.totalVotes || ranked.reduce((s, x) => s + x.v, 0);
  const leader = total > 0 ? ranked[0].c : null;
  const margin = total > 0 ? ((ranked[0].v - (ranked[1]?.v ?? 0)) / total) * 100 : 0;
  const dMargin = total > 0 && d && r ? (((u.votes[d.id] ?? 0) - (u.votes[r.id] ?? 0)) / total) * 100 : null;
  const swing = dMargin != null && u.baselineMargin != null ? dMargin - u.baselineMargin : null;
  return { u, leader, margin, dMargin, swing, outstanding: Math.max(0, (u.expectedVotes ?? 0) - u.totalVotes) };
}

const swingLevel = (s: number): RatingLevel => (Math.abs(s) >= 20 ? 'solid' : Math.abs(s) >= 10 ? 'likely' : Math.abs(s) >= 5 ? 'lean' : Math.abs(s) >= 2 ? 'tilt' : 'tossup');
const signed = (v: number | null, digits = 1) => (v == null ? '—' : `${v >= 0 ? 'D' : 'R'}+${Math.abs(v).toFixed(digits)}`);
const partyOf = (v: number | null): Party | null => (v == null ? null : v >= 0 ? 'D' : 'R');

function fillFor(s: UnitStats, mode: Mode): string {
  switch (mode) {
    case 'margin': {
      if (!s.leader) return NEUTRAL.upcoming;
      const lvl = marginToLevel(s.margin);
      return RAMP[s.leader.party][lvl === 'tossup' ? 'tilt' : lvl];
    }
    case 'swing':
      return s.swing == null ? NEUTRAL.upcoming : levelColor(partyOf(s.swing), swingLevel(s.swing));
    case 'counted': {
      const e = s.u.eevp ?? 0;
      return e <= 0 ? NEUTRAL.noRace : COUNT_RAMP[Math.min(4, Math.floor(e / 20))];
    }
    case 'baseline': {
      const b = s.u.baselineMargin;
      if (b == null) return NEUTRAL.noData;
      const lvl = marginToLevel(Math.abs(b));
      return RAMP[b >= 0 ? 'D' : 'R'][lvl === 'tossup' ? 'tilt' : lvl];
    }
  }
}

/** County results poll every 15 s while the page is open (sim counties for admins viewing the simulation). */
function useCounties(raceId: string) {
  const [data, setData] = useState<RaceCounties | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/races/${encodeURIComponent(raceId)}/counties${wantsSimView() ? '?view=sim' : ''}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.status === 429 ? 'rate limited, retrying' : `HTTP ${res.status}`);
        const j = (await res.json()) as RaceCounties;
        if (alive) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [raceId]);
  return { data, err };
}

export function RaceView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const race = useElection((s) => s.races[id]);
  const loaded = useElection((s) => s.loaded);
  const { data, err } = useCounties(id);
  const [shapes, setShapes] = useState<Map<string, CountyShape> | null>(null);
  const [districtPath, setDistrictPath] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'expected', dir: -1 });
  const [countyHistory, setCountyHistory] = useState<CountyHistory | null>(null);
  useEffect(() => {
    void loadCountyHistory().then(setCountyHistory);
  }, []);

  useEffect(() => {
    void loadCounties().then(setShapes);
  }, []);
  useEffect(() => {
    if (race?.office !== 'H') return setDistrictPath(null);
    void loadDistricts().then((ds) => setDistrictPath(ds.find((d) => d.id === race.id)?.d ?? null));
  }, [race?.office, race?.id]);

  const main = useMemo(() => {
    if (!race) return { d: undefined, r: undefined, standIn: null };
    return sides(race); // an independent opponent stands in for the missing / trailing party
  }, [race]);
  // Senate and governor races compare each county with the same seat's previous contest; House
  // races (and seats without county data for it) use NYT's comparison: the 2024 presidential margin,
  // or the seat's 2024 House race for districts whose lines didn't change.
  const prevCounty = race && race.office !== 'H' ? countyHistory?.races[race.id] : undefined;
  const base: Baseline = prevCounty
    ? { year: prevCounty.label, short: `'${prevCounty.label.slice(2, 4)}`, name: `${prevCounty.label} ${race!.office === 'S' ? 'Senate' : 'governor'} race` }
    : data?.baseline === 'house2024'
      ? HOUSE24_BASELINE
      : PRES_BASELINE;
  const rows = useMemo(
    () =>
      race && data
        ? data.units.map((u) => stats(prevCounty ? { ...u, baselineMargin: u.fips != null ? (prevCounty.units[u.fips] ?? null) : null } : u, race, main.d, main.r))
        : [],
    [race, data, main, prevCounty],
  );
  const anyVotes = rows.some((s) => s.u.totalVotes > 0);
  const activeMode: Mode = mode ?? (anyVotes ? 'margin' : 'baseline');

  if (!race) return <div className="empty">{loaded ? `No race "${id}"` : 'Loading…'}</div>;

  const stFips = STATE_BY_POSTAL[race.state]?.fips ?? '';
  const mapped = shapes ? rows.filter((s) => s.u.fips && shapes.has(s.u.fips)) : [];
  // House: show the whole state's units clipped to the district; else just the reported units.
  // A state's shapes come from one set: us-atlas counties, or (CT, AK) the newer extra units.
  const unitSet = mapped.length ? shapes?.get(mapped[0].u.fips!)?.set : undefined;
  const shapeList = shapes ? (race.office === 'H' ? [...shapes.values()].filter((c) => c.fips.startsWith(stFips) && c.set === unitSet) : mapped.map((s) => shapes.get(s.u.fips!)!)) : [];
  const byFips = new Map(rows.filter((s) => s.u.fips).map((s) => [s.u.fips!, s]));
  const box = pathBounds(race.office === 'H' && districtPath ? [districtPath] : shapeList.map((c) => c.d));
  const hoverStats = hover ? rows.find((s) => s.u.id === hover.id) : undefined;

  const outstandingTotal = rows.reduce((s, x) => s + x.outstanding, 0);
  const outstandingDLean = rows.filter((x) => (x.u.baselineMargin ?? 0) > 0).reduce((s, x) => s + x.outstanding, 0);
  const remaining = [...rows].sort((a, b) => b.outstanding - a.outstanding).slice(0, 12);
  const shifts = rows
    .filter((x) => x.swing != null && (x.u.eevp ?? 0) >= 20)
    .sort((a, b) => Math.abs(b.swing!) - Math.abs(a.swing!))
    .slice(0, 8);

  const sortVal: Record<string, (s: UnitStats) => number | string> = {
    name: (s) => s.u.name,
    eevp: (s) => s.u.eevp ?? -1,
    votes: (s) => s.u.totalVotes,
    expected: (s) => s.u.expectedVotes ?? 0,
    d: (s) => (main.d && s.u.totalVotes ? (s.u.votes[main.d.id] ?? 0) / s.u.totalVotes : -1),
    r: (s) => (main.r && s.u.totalVotes ? (s.u.votes[main.r.id] ?? 0) / s.u.totalVotes : -1),
    margin: (s) => s.dMargin ?? -999,
    base: (s) => s.u.baselineMargin ?? -999,
    swing: (s) => s.swing ?? -999,
  };
  const sorted = [...rows].sort((a, b) => {
    const x = sortVal[sort.key](a);
    const y = sortVal[sort.key](b);
    return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir;
  });
  const th = (key: string, label: string, num = true) => (
    <th className={`${num ? 'num' : ''} sortable ${sort.key === key ? 'sorted' : ''}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : -1 }))}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const f = forecastFor(race);
  const bp = race.market?.byParty;
  // Alaska reports by state house district; Connecticut by its 9 planning regions (FIPS 091x0),
  // which replaced its counties after the bundled county shapes were drawn.
  const unitWord = rows.some((s) => s.u.level === 'state_house_district') ? 'districts' : race.state === 'CT' ? 'planning regions' : race.office === 'H' ? 'county parts' : 'counties';

  return (
    <div className="race-view">
      <header className="panel rv-head">
        <div className="rv-title-row">
          <button className="back-btn" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>
            ← Back
          </button>
          <h1>
            {raceName(race)} <span className="rc-office">{OFFICE_TITLE[race.office]}</span>
          </h1>
          <WatchStar id={race.id} />
          <span className={`badge status-${race.status}`}>{statusText(race)}</span>
          {race.certified ? (
            <span className="badge certified" title="The state has certified this result">
              Certified
            </span>
          ) : null}
          {race.flip && race.winner ? (
            <span className="badge flip" style={{ background: PARTY_COLOR[race.winner] }}>
              {race.winner} GAIN
            </span>
          ) : null}
          <span className="rv-meta muted small">
            {race.incumbentRunning ? `Incumbent: ${race.incumbentName}` : 'Open seat'} · {race.priorParty ? `${race.priorParty} held` : 'prior party unknown'} · FLIPR/Cook{' '}
            <b>{f?.label ?? '—'}</b> · Polymarket{' '}
            <b>
              {bp && Object.keys(bp).length
                ? (Object.entries(bp) as [Party, number][])
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 2)
                    .map(([p, v]) => `${p} ${fmtProb(v)}`)
                    .join(' / ')
                : '—'}
            </b>{' '}
            · polls close {fmtEt(race.pollClose)} ET
          </span>
        </div>
        {race.expectedLater ? <div className="rc-note">{race.expectedLater}.</div> : null}
        {race.rcv && !race.expectedLater ? <div className="rc-note">Ranked-choice race: first-choice votes shown. If no one passes 50%, the final result can take days.</div> : null}
        <div className="rv-body-row">
        <div className="rv-cands" style={{ '--n': Math.max(1, Math.min(4, race.candidates.length)) } as React.CSSProperties}>
          {race.candidates.slice(0, 4).map((c) => (
            <div key={c.id} className={`rv-cand ${c.winner ? 'won' : ''}`}>
              <div className="rv-cand-name">
                <i style={{ background: PARTY_COLOR[c.party] }} />
                {c.name}
                {c.incumbent ? <span className="inc">INC</span> : null}
                {c.winner ? ' ✔' : ''}
              </div>
              <div className="rv-cand-pct">{race.totalVotes ? `${c.pct.toFixed(1)}%` : '—'}</div>
              <div className="rc-bar">
                <div style={{ width: `${c.pct}%`, background: PARTY_COLOR[c.party] }} />
              </div>
              <div className="muted small">{race.totalVotes ? `${fmtNum(c.votes)} votes` : c.partyName}</div>
            </div>
          ))}
          <div className="rv-progress">
            <div className="rc-progress-bar">
              <div style={{ width: `${Math.min(100, race.eevp ?? 0)}%` }} />
            </div>
            <span className="small">
              {race.totalVotes ? `${Math.round(race.eevp ?? 0)}% of expected vote · ${fmtNum(race.totalVotes)} votes` : 'No votes yet'}
              {race.expectedVotes ? ` · ~${fmtNum(race.expectedVotes)} expected` : ''}
            </span>
          </div>
        </div>
        <PrevResults race={race} />
        </div>
      </header>

      <section className="panel rv-map">
        <div className="panel-head">
          <h2>{race.office === 'H' ? 'Counties in the district' : 'Results by county'}</h2>
          <div className="chips">
            {MODES.map((m) => (
              <button key={m.id} className={`chip ${activeMode === m.id ? 'on' : ''}`} onClick={() => setMode(m.id)}>
                {m.id === 'swing' ? `Shift vs ${base.year}` : m.id === 'baseline' ? `${base.year} result` : m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rv-map-body">
          {!data ? (
            <div className="empty">{err ? `County results unavailable (${err})` : 'Loading county results…'}</div>
          ) : !rows.length ? (
            <div className="empty">No county-level results published for this race yet.</div>
          ) : !shapes ? (
            <div className="empty">Loading county map…</div>
          ) : !box || !mapped.length ? (
            <div className="empty">This state reports by {unitWord}, which have no map shapes. See the table below.</div>
          ) : (
            <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet">
              {race.office === 'H' && districtPath ? (
                <defs>
                  <clipPath id="rv-district">
                    <path d={districtPath} />
                  </clipPath>
                </defs>
              ) : null}
              <g clipPath={race.office === 'H' && districtPath ? 'url(#rv-district)' : undefined}>
                {shapeList.map((c) => {
                  const s = byFips.get(c.fips);
                  return (
                    <path
                      key={c.fips}
                      d={c.d}
                      className={`rv-county ${s ? 'has' : ''} ${hover && s && hover.id === s.u.id ? 'hl' : ''}`}
                      fill={s ? fillFor(s, activeMode) : NEUTRAL.noRace}
                      onMouseMove={(e) => s && setHover({ id: s.u.id, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover(null)}
                    />
                  );
                })}
              </g>
              {race.office === 'H' && districtPath ? <path d={districtPath} className="rv-district-outline" /> : null}
            </svg>
          )}
        </div>
        <MapLegend mode={activeMode} base={base} />
      </section>

      <aside className="rv-side">
        <section className="panel">
          <div className="panel-head">
            <h2>Where the vote is out</h2>
            <span className="muted small">NYT expected-vote estimates</span>
          </div>
          <div className="rv-out-summary small">
            <b>{fmtNum(outstandingTotal)}</b> votes outstanding
            {outstandingTotal ? (
              <>
                {' '}
                · <b style={{ color: PARTY_COLOR.D }}>{Math.round((outstandingDLean / outstandingTotal) * 100)}%</b> in {unitWord} the Democrat carried in the {base.name}
              </>
            ) : null}
          </div>
          <ul className="rv-list">
            {remaining.map((s) => (
              <li key={s.u.id} onMouseEnter={(e) => setHover({ id: s.u.id, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)}>
                <span className="rl-name">{s.u.name}</span>
                <span className="rl-bar">
                  <i style={{ width: `${outstandingTotal ? (s.outstanding / remaining[0].outstanding) * 100 : 0}%` }} />
                </span>
                <span className="rl-num">{fmtNum(s.outstanding)}</span>
                <span className="rl-lean" style={{ color: s.u.baselineMargin != null ? PARTY_COLOR[s.u.baselineMargin >= 0 ? 'D' : 'R'] : undefined }}>
                  {base.short} {signed(s.u.baselineMargin, 0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Biggest shifts from {base.year}</h2>
            <span className="muted small">{unitWord} ≥20% counted</span>
          </div>
          <ul className="rv-list">
            {shifts.map((s) => (
              <li key={s.u.id} onMouseEnter={(e) => setHover({ id: s.u.id, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)}>
                <span className="rl-name">{s.u.name}</span>
                <span className="rl-num">now {signed(s.dMargin, 0)}</span>
                <span className="rl-lean muted">
                  {base.short} {signed(s.u.baselineMargin, 0)}
                </span>
                <b style={{ color: PARTY_COLOR[s.swing! >= 0 ? 'D' : 'R'] }}>{signed(s.swing)}</b>
              </li>
            ))}
            {!shifts.length ? <li className="empty">Appears once counties report</li> : null}
          </ul>
          {main.standIn ? (
            <p className="muted small rv-standin">
              {main[main.standIn]!.name} ({main[main.standIn]!.partyName || 'independent'}) counted on the {main.standIn === 'd' ? 'Democratic' : 'Republican'} side
            </p>
          ) : null}
        </section>
      </aside>

      <section className="panel rv-table">
        <div className="panel-head">
          <h2>
            {rows.length} {unitWord}
          </h2>
          <span className="muted small">
            {data?.source && data.source !== 'none' ? `Source: ${data.source.replace(' (G)', '')}` : ''} {data?.updatedAt ? `· updated ${fmtEt(data.updatedAt)} ET` : ''} · refreshes every 15
            s
          </span>
        </div>
        <div className="table-scroll">
          <table className="race-table">
            <thead>
              <tr>
                {th('name', 'Name', false)}
                {th('eevp', '% in')}
                {th('votes', 'Votes')}
                {th('expected', 'Expected')}
                {main.d ? th('d', main.d.lastName) : null}
                {main.r ? th('r', main.r.lastName) : null}
                {th('margin', 'Margin')}
                {th('base', base.year)}
                {th('swing', 'Shift')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.u.id} className={hover?.id === s.u.id ? 'hl' : ''} onMouseEnter={(e) => setHover({ id: s.u.id, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)}>
                  <td>{s.u.name}</td>
                  <td className="num">{s.u.totalVotes ? `${Math.round(s.u.eevp ?? 0)}%` : '—'}</td>
                  <td className="num">{fmtNum(s.u.totalVotes)}</td>
                  <td className="num muted">{fmtNum(s.u.expectedVotes)}</td>
                  {main.d ? <td className="num">{s.u.totalVotes ? `${(((s.u.votes[main.d.id] ?? 0) / s.u.totalVotes) * 100).toFixed(1)}%` : '—'}</td> : null}
                  {main.r ? <td className="num">{s.u.totalVotes ? `${(((s.u.votes[main.r.id] ?? 0) / s.u.totalVotes) * 100).toFixed(1)}%` : '—'}</td> : null}
                  <td className="num" style={{ color: s.dMargin != null ? PARTY_COLOR[s.dMargin >= 0 ? 'D' : 'R'] : undefined }}>
                    {signed(s.dMargin)}
                  </td>
                  <td className="num muted">{signed(s.u.baselineMargin)}</td>
                  <td className="num" style={{ color: s.swing != null ? PARTY_COLOR[s.swing >= 0 ? 'D' : 'R'] : undefined }}>
                    {signed(s.swing)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {hover && hoverStats ? (
        <FloatingCard x={hover.x} y={hover.y} pinned={false}>
          <div className="race-card county-card">
            <div className="rc-title">
              {hoverStats.u.name} <span className="rc-office">{hoverStats.u.totalVotes ? `${Math.round(hoverStats.u.eevp ?? 0)}% in` : 'no votes yet'}</span>
            </div>
            <table className="rc-cands">
              <tbody>
                {race.candidates.slice(0, 4).map((c) => {
                  const v = hoverStats.u.votes[c.id] ?? 0;
                  const pct = hoverStats.u.totalVotes ? (v / hoverStats.u.totalVotes) * 100 : 0;
                  return (
                    <tr key={c.id}>
                      <td className="rc-name">
                        <div className="rc-party">
                          <i style={{ background: PARTY_COLOR[c.party] }} />
                          {c.name}
                        </div>
                      </td>
                      <td className="rc-votes">{fmtNum(v)}</td>
                      <td className="rc-pct">{hoverStats.u.totalVotes ? `${pct.toFixed(1)}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="rc-foot">
              <div>
                <label>Margin</label>
                <span>{signed(hoverStats.dMargin)}</span>
              </div>
              <div>
                <label>{prevCounty ? base.name : '2024 pres.'}</label>
                <span>{signed(hoverStats.u.baselineMargin)}</span>
              </div>
              <div>
                <label>Shift</label>
                <span>{signed(hoverStats.swing)}</span>
              </div>
              <div>
                <label>Outstanding</label>
                <span>{fmtNum(hoverStats.outstanding)}</span>
              </div>
            </div>
          </div>
        </FloatingCard>
      ) : null}
    </div>
  );
}

function MapLegend({ mode, base }: { mode: Mode; base: Baseline }) {
  const levels = ['solid', 'likely', 'lean', 'tilt'] as const;
  const labels: Record<Mode, string[]> = {
    margin: ['15+', '7', '3', '<3', '', '<3', '3', '7', '15+'],
    swing: ['D 20+', '10', '5', '2', '±2', '2', '5', '10', 'R 20+'],
    counted: [],
    baseline: ['15+', '7', '3', '<3', '', '<3', '3', '7', '15+'],
  };
  if (mode === 'counted') {
    return (
      <div className="rv-legend small muted">
        {COUNT_RAMP.map((c, i) => (
          <span key={c}>
            <i className="sw" style={{ background: c }} />
            {i * 20}–{i * 20 + 20}%
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="rv-legend small muted">
      <span className="legend-ramp-inline">
        {levels.map((l) => (
          <i key={`d${l}`} className="sw" style={{ background: RAMP.D[l] }} />
        ))}
        {mode === 'swing' ? <i className="sw" style={{ background: NEUTRAL.tossup }} /> : null}
        {[...levels].reverse().map((l) => (
          <i key={`r${l}`} className="sw" style={{ background: RAMP.R[l] }} />
        ))}
      </span>
      <span>{mode === 'swing' ? `Shift in D–R margin vs the ${base.name} (pts)` : mode === 'margin' ? 'Leader’s margin (pts)' : `${base.name} margin (pts)`}</span>
      <span className="muted">{labels[mode].filter(Boolean).join(' · ')}</span>
    </div>
  );
}
