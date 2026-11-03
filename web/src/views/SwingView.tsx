import { useMemo, useState, type ReactNode } from 'react';
import type { Race } from '../../../shared/src/types';
import { useRaceHover, type HoverFn } from '../components/chamber/useRaceHover';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PARTY_COLOR } from '../lib/colors';
import { fmtNum, raceName, stateName } from '../lib/format';
import { dMargin, fmtLean, HISTORY, leanParty, pres2024For, prevFor, prevText } from '../lib/history';
import {
  BASELINE_LABEL,
  districtBaseline,
  houseVote,
  likeForLike,
  nationalBaseline,
  OFFICE_LABEL,
  raceBaseline,
  raceSwingsByState,
  netSeatChange,
  stateSwings,
  swingAgainstPresident,
  type Baseline,
  type Office,
  type RaceBaseline,
} from '../lib/swing';
import { CALLOUTS, NATION_OUTLINE, STATE_BORDERS, STATE_SHAPES, VIEWBOX } from '../map/geo';
import { useElection } from '../store/election';

const PRES_PARTY_2026 = 'R' as const;
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
const leanColor = (m: number | null | undefined) => {
  const p = leanParty(m);
  return p ? PARTY_COLOR[p] : undefined;
};

/** Diverging swing scale: red (toward R) - neutral gray - blue (toward D). Validated on the dark panel. */
const SWING_STEPS = [
  { max: -10, fill: '#f0545a', label: 'R10', legend: 'R +10 or more' },
  { max: -5, fill: '#b74a53', label: 'R5', legend: 'R +5–10' },
  { max: -2, fill: '#7f3d48', label: 'R2', legend: 'R +2–5' },
  { max: 2, fill: '#3a4150', label: 'even', legend: 'within 2' },
  { max: 5, fill: '#33538f', label: 'D2', legend: 'D +2–5' },
  { max: 10, fill: '#3f70c6', label: 'D5', legend: 'D +5–10' },
  { max: Infinity, fill: '#4d8ef7', label: 'D10', legend: 'D +10 or more' },
];
const swingFill = (s: number) => (SWING_STEPS.find((x) => s < x.max) ?? SWING_STEPS[SWING_STEPS.length - 1]).fill;

function Panel({ title, note, children, className = '' }: { title: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {note ? <span className="muted small">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ tiles

function SwingTiles({ races }: { races: Race[] }) {
  const hv = houseVote(races);
  const house = races.filter((r) => r.office === 'H');
  const lfl = likeForLike(house, districtBaseline.pres24);
  const statewide = races.filter((r) => r.office !== 'H');
  const seat = likeForLike(statewide, (r) => prevFor(r)?.margin ?? null);
  // Framed from the out-party's side so the expected midterm gain reads as a positive number.
  const hc = netSeatChange(races, 'H', 'D');
  const tile = (label: string, value: ReactNode, sub: ReactNode, color?: string) => (
    <div className="tile sw-tile">
      <b style={{ color }}>{value}</b>
      <span>{label}</span>
      <small>{sub}</small>
    </div>
  );
  const vs = (b: Baseline) => (hv.margin == null ? null : hv.margin - nationalBaseline(b));
  return (
    <div className="tiles sw-tiles">
      {tile(
        'House vote tonight',
        hv.margin == null ? '—' : fmtLean(hv.margin),
        hv.margin == null ? 'appears as votes are counted' : `${hv.counted.toFixed(0)}% of expected vote · ${fmtNum(hv.total)}`,
        leanColor(hv.margin),
      )}
      {(['pres24', 'house24', 'house22'] as Baseline[]).map((b) => {
        const d = vs(b);
        return (
          <div key={b} className="tile sw-tile">
            <b style={{ color: leanColor(d) }}>{d == null ? fmtLean(nationalBaseline(b)) : fmtLean(d)}</b>
            <span>{d == null ? BASELINE_LABEL[b] : `Shift vs ${BASELINE_LABEL[b]}`}</span>
            <small>{d == null ? 'national baseline' : `was ${fmtLean(nationalBaseline(b))} · raw total, skews while counting`}</small>
          </div>
        );
      })}
      {tile(
        'Like-for-like House shift',
        lfl.swing == null ? '—' : fmtLean(lfl.swing),
        lfl.n ? `vs 2024 president, ${lfl.n} districts ≥50% counted` : 'each district vs its own 2024 presidential margin',
        leanColor(lfl.swing),
      )}
      {tile(
        'Same-seat shift · Senate & Gov',
        seat.swing == null ? '—' : fmtLean(seat.swing),
        seat.n ? `vs each seat's last race, ${seat.n} races ≥50% counted` : "each race vs that seat's previous result",
        leanColor(seat.swing),
      )}
      {tile(
        'DEM House seats vs before',
        hc ? `${hc.change > 0 ? '+' : ''}${hc.change}` : '—',
        hc ? `net seats flipped, won + leading · ${hc.decided} races reporting` : 'net seats flipped; appears with results',
        hc ? (hc.change > 0 ? PARTY_COLOR.D : hc.change < 0 ? PARTY_COLOR.R : undefined) : undefined,
      )}
    </div>
  );
}

// ------------------------------------------------------------------ district scatter

const AX = 60; // axis range ±60 pts; beyond is clamped to the edge
/** House / Senate / Governor switch shared by the widgets. */
function OfficeSwitch({ value, onChange }: { value: Office; onChange: (o: Office) => void }) {
  return (
    <span className="seg-control mini">
      {(['H', 'S', 'G'] as Office[]).map((o) => (
        <button key={o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>
          {OFFICE_LABEL[o]}
        </button>
      ))}
    </span>
  );
}
const lastLabel = (o: Office) => (o === 'H' ? "'24 House" : 'Last race');
const AT_LARGE_TXT = (r: Race) => `${r.state}-${AT_LARGE.has(r.state) ? 'AL' : r.district}`;

function DistrictScatter({ races, onHover }: { races: Race[]; onHover: HoverFn }) {
  const [office, setOffice] = useState<Office>('H');
  const [baseline, setBaseline] = useState<RaceBaseline>('pres24');
  const pts = useMemo(
    () =>
      races
        .filter((r) => r.office === office && (r.eevp ?? 0) >= 10)
        .map((r) => ({ r, x: raceBaseline[baseline](r), y: dMargin(r) }))
        .filter((p): p is { r: Race; x: number; y: number } => p.x != null && p.y != null),
    [races, office, baseline],
  );
  const lfl = likeForLike(
    races.filter((r) => r.office === office),
    raceBaseline[baseline],
  );
  const statewide = office !== 'H';
  const unit = statewide ? 'races' : 'districts';
  const W = 400;
  const H = 400;
  const pad = 34;
  const sx = (v: number) => pad + ((Math.max(-AX, Math.min(AX, v)) + AX) / (2 * AX)) * (W - pad - 8);
  const sy = (v: number) => 8 + ((AX - Math.max(-AX, Math.min(AX, v))) / (2 * AX)) * (H - pad - 8);
  const ticks = [-40, -20, 0, 20, 40];
  const above = pts.filter((p) => p.y > p.x).length;
  // Statewide dots get a state label when it has room: most-counted first, skipping any label that
  // would overlap one already placed (or another dot). Hover still identifies every dot.
  const labeled = new Map<string, 'right' | 'left'>();
  if (statewide) {
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = pts.map((q) => ({ x0: sx(q.x) - 5, x1: sx(q.x) + 5, y0: sy(q.y) - 5, y1: sy(q.y) + 5 }));
    const placed: typeof boxes = [];
    for (const q of [...pts].sort((a, b) => (b.r.eevp ?? 0) - (a.r.eevp ?? 0))) {
      for (const side of ['right', 'left'] as const) {
        const x0 = side === 'right' ? sx(q.x) + 7 : sx(q.x) - 21;
        const box = { x0, x1: x0 + 14, y0: sy(q.y) - 5, y1: sy(q.y) + 5 };
        const hit = (o: typeof box) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0;
        if (placed.some(hit) || boxes.some(hit)) continue;
        placed.push(box);
        labeled.set(q.r.id, side);
        break;
      }
    }
  }
  const xLabel =
    baseline === 'pres24'
      ? `2024 presidential margin in the ${statewide ? 'state' : 'district'}`
      : office === 'H'
        ? '2024 House margin (same lines only)'
        : office === 'S'
          ? 'Previous race for the same Senate seat'
          : 'Previous governor’s race';
  return (
    <Panel
      title={`${OFFICE_LABEL[office]} vs baseline`}
      className="sw-scatter"
      note={
        <span className="sw-switches">
          <OfficeSwitch value={office} onChange={setOffice} />
          <span className="seg-control mini">
            {(['pres24', 'last'] as RaceBaseline[]).map((b) => (
              <button key={b} className={baseline === b ? 'on' : ''} onClick={() => setBaseline(b)}>
                {b === 'pres24' ? "'24 President" : lastLabel(office)}
              </button>
            ))}
          </span>
        </span>
      }
    >
      <div className="sw-scatter-body">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scatter of ${OFFICE_LABEL[office]} margins tonight against their baseline`}>
          {ticks.map((t) => (
            <g key={t} className="sw-grid">
              <line x1={sx(t)} x2={sx(t)} y1={8} y2={H - pad} />
              <line x1={pad} x2={W - 8} y1={sy(t)} y2={sy(t)} />
              <text x={sx(t)} y={H - pad + 14} textAnchor="middle">
                {t === 0 ? '0' : fmtLean(t, 0)}
              </text>
              <text x={pad - 4} y={sy(t)} dy="0.32em" textAnchor="end">
                {t === 0 ? '0' : fmtLean(t, 0)}
              </text>
            </g>
          ))}
          {/* No-change diagonal, and the average like-for-like swing as a parallel line. */}
          <line className="sw-diag" x1={sx(-AX)} y1={sy(-AX)} x2={sx(AX)} y2={sy(AX)} />
          {lfl.swing != null ? <line className="sw-uniform" x1={sx(-AX)} y1={sy(-AX + lfl.swing)} x2={sx(AX)} y2={sy(AX + lfl.swing)} /> : null}
          <text className="sw-corner" x={pad + 6} y={18}>
            ↑ better for Democrats than baseline
          </text>
          <text className="sw-corner" x={W - 12} y={H - pad - 8} textAnchor="end">
            better for Republicans ↓
          </text>
          {pts.map((p) => (
            <g key={p.r.id} onMouseMove={(e) => onHover(p.r.id, e)} onMouseLeave={() => onHover(null)}>
              <circle cx={sx(p.x)} cy={sy(p.y)} r={statewide ? 12 : 9} className="sw-hit" />
              <circle cx={sx(p.x)} cy={sy(p.y)} r={statewide ? 5.5 : 4} className="sw-dot" fill={PARTY_COLOR[p.y >= 0 ? 'D' : 'R']} opacity={0.45 + Math.min(0.55, (p.r.eevp ?? 0) / 180)} />
              {labeled.has(p.r.id) ? (
                <text className="sw-dot-label" x={sx(p.x) + (labeled.get(p.r.id) === 'right' ? 8 : -8)} y={sy(p.y)} dy="0.32em" textAnchor={labeled.get(p.r.id) === 'right' ? 'start' : 'end'}>
                  {p.r.state}
                </text>
              ) : null}
            </g>
          ))}
          <text className="sw-axis-label" x={(W + pad) / 2} y={H - 4} textAnchor="middle">
            {xLabel}
          </text>
          <text className="sw-axis-label" transform={`translate(10 ${(H - pad) / 2}) rotate(-90)`} textAnchor="middle">
            Tonight’s margin
          </text>
        </svg>
        {!pts.length ? (
          <div className="sw-overlay muted">
            {OFFICE_LABEL[office]} {unit} plot here once ≥10% of their vote is counted{baseline === 'last' ? ' (D-vs-R contests with a comparable previous result)' : ''}.
          </div>
        ) : null}
      </div>
      <div className="sw-foot small muted">
        {pts.length ? (
          <>
            {pts.length} {unit} · <b>{above}</b> above the diagonal (D running ahead of baseline), <b>{pts.length - above}</b> below
            {lfl.swing != null ? (
              <>
                {' '}
                · average shift <b style={{ color: leanColor(lfl.swing) }}>{fmtLean(lfl.swing)}</b> (solid line)
              </>
            ) : null}
          </>
        ) : (
          `Each dot is a ${statewide ? `${OFFICE_LABEL[office]} race` : 'House district'}: left–right is how it voted before, up–down is tonight. Dots above the gray diagonal are bluer than before.`
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ state swing map

type MapBaseline = Baseline | 'last';
function StateSwingMap({ races }: { races: Race[] }) {
  const [office, setOffice] = useState<Office>('H');
  const [baseline, setBaseline] = useState<MapBaseline>('pres24');
  const [hover, setHover] = useState<{ st: string; x: number; y: number } | null>(null);
  const options: MapBaseline[] = office === 'H' ? ['pres24', 'house24', 'house22'] : ['pres24', 'last'];
  const b: MapBaseline = options.includes(baseline) ? baseline : 'pres24';
  const swings = useMemo((): Record<string, { swing: number; now: number; base: number; counted: number; race?: Race }> => {
    if (office === 'H') return stateSwings(races, b as Baseline);
    return raceSwingsByState(races, office, b === 'last' ? 'last' : 'pres24');
  }, [races, office, b]);
  const hasRace = useMemo(() => new Set(races.filter((r) => r.office === office).map((r) => r.state)), [races, office]);
  const h = hover ? swings[hover.st] : undefined;
  const n = Object.keys(swings).length;
  const optLabel = (o: MapBaseline) => (o === 'pres24' ? "vs '24 Pres" : o === 'house24' ? "vs '24 House" : o === 'house22' ? "vs '22 House" : 'vs last race');
  const baseLabel = (o: MapBaseline, race?: Race) => {
    if (o === 'last') {
      const p = race ? prevFor(race) : null;
      return p ? `Last race (${p.label})` : 'Last race';
    }
    return BASELINE_LABEL[o as Baseline];
  };
  const pick = (o: Office) => {
    setOffice(o);
    if (!(o === 'H' ? ['pres24', 'house24', 'house22'] : ['pres24', 'last']).includes(baseline)) setBaseline('pres24');
  };
  return (
    <Panel
      title={office === 'H' ? 'House vote shift by state' : `${OFFICE_LABEL[office]} shift by state`}
      className="sw-map"
      note={
        <span className="sw-switches">
          <OfficeSwitch value={office} onChange={pick} />
          <span className="seg-control mini">
            {options.map((o) => (
              <button key={o} className={b === o ? 'on' : ''} onClick={() => setBaseline(o)}>
                {optLabel(o)}
              </button>
            ))}
          </span>
        </span>
      }
    >
      <div className="sw-map-body">
        <svg viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Map of ${OFFICE_LABEL[office]} shift by state`}>
          {STATE_SHAPES.map((s) => {
            const v = swings[s.postal];
            return (
              <path
                key={s.postal}
                d={s.d}
                className={`state ${v ? 'has-race' : 'no-race'}`}
                fill={v ? swingFill(v.swing) : hasRace.has(s.postal) ? '#1b2130' : '#141923'}
                onMouseMove={(e) => setHover({ st: s.postal, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
          <path d={STATE_BORDERS} className="state-borders" />
          <path d={NATION_OUTLINE} className="nation-outline" />
          {STATE_SHAPES.filter((s) => swings[s.postal] && !CALLOUTS.includes(s.postal)).map((s) => (
            <text key={s.postal} x={s.centroid[0]} y={s.centroid[1]} dy="0.35em" textAnchor="middle" className="state-label sw-label">
              {fmtLean(swings[s.postal].swing, 0)}
            </text>
          ))}
        </svg>
        {!n ? (
          <div className="sw-overlay muted">
            {office === 'H' ? 'States shade in once ≥30% of their House vote is counted.' : `States with a ${OFFICE_LABEL[office].toLowerCase()} race shade in once ≥30% is counted.`}
          </div>
        ) : null}
      </div>
      <div className="sw-legend">
        {SWING_STEPS.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.fill }} />
            {s.legend}
          </span>
        ))}
      </div>
      {hover ? (
        <div className="sw-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b>{stateName(hover.st)}</b>
          {h ? (
            <>
              <div>
                {office === 'H' ? 'House vote' : `${OFFICE_LABEL[office]} race`} tonight <b style={{ color: leanColor(h.now) }}>{fmtLean(h.now)}</b> ({h.counted.toFixed(0)}% counted)
              </div>
              <div>
                {baseLabel(b, h.race)} <b style={{ color: leanColor(h.base) }}>{fmtLean(h.base)}</b>
              </div>
              <div>
                Shift <b style={{ color: leanColor(h.swing) }}>{fmtLean(h.swing)}</b>
              </div>
            </>
          ) : office !== 'H' && !hasRace.has(hover.st) ? (
            <div className="muted">No {OFFICE_LABEL[office].toLowerCase()} race this year.</div>
          ) : (
            <div className="muted">
              Not enough counted yet
              {b !== 'pres24' ? ' (or no comparable baseline)' : ''}.
            </div>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

// ------------------------------------------------------------------ midterm history

function MidtermHistory({ races }: { races: Race[] }) {
  const hv = houseVote(races);
  const hc = netSeatChange(races, 'H', PRES_PARTY_2026);
  const sc = netSeatChange(races, 'S', PRES_PARTY_2026);
  const now = hv.margin != null && hv.counted >= 20 ? swingAgainstPresident(hv.margin, HISTORY.houseVote['2024'].national.margin, PRES_PARTY_2026) : null;
  const rows = HISTORY.midterms.map((m) => ({
    ...m,
    against: m.houseMargin != null && m.prevHouseMargin != null ? swingAgainstPresident(m.houseMargin, m.prevHouseMargin, m.presParty) : null,
  }));
  const maxSeats = 65;
  const closest = now != null ? [...rows].filter((r) => r.against != null).sort((a, b) => Math.abs(a.against! - now) - Math.abs(b.against! - now))[0] : null;
  const avg = Math.round(rows.reduce((s, r) => s + (r.houseSeatChange ?? 0), 0) / rows.length);
  const bar = (v: number | null, party: 'D' | 'R') => {
    if (v == null) return null;
    const w = (Math.min(Math.abs(v), maxSeats) / maxSeats) * 50;
    return <i className="sw-bar" style={{ width: `${w}%`, left: v < 0 ? `${50 - w}%` : '50%', background: PARTY_COLOR[party] }} />;
  };
  return (
    <Panel title="Midterms for the president’s party" className="sw-hist" note={`avg House ${avg} seats since 1994`}>
      <div className="sw-hist-head small muted">
        <span>Year</span>
        <span>House seats won/lost</span>
        <span title="House popular-vote swing from the presidential year before, toward the party out of the White House">Vote swing vs pres. year</span>
        <span>Senate</span>
      </div>
      <div className="sw-hist-rows">
        {rows.map((m) => (
          <div
            key={m.year}
            className={`sw-hist-row ${closest?.year === m.year ? 'closest' : ''}`}
            title={`${m.year}: president's party (${m.presParty}) ${m.houseSeatChange} House seats, ${m.senateSeatChange} Senate; House vote ${fmtLean(m.houseMargin)} vs ${fmtLean(m.prevHouseMargin)} two years earlier`}
          >
            <span className="sw-year">
              <i className="party-chip" style={{ background: PARTY_COLOR[m.presParty] }} />
              {m.year}
            </span>
            <span className="sw-track">
              <i className="sw-zero" />
              {bar(m.houseSeatChange, m.presParty)}
              <b className="sw-val">{m.houseSeatChange != null ? `${m.houseSeatChange > 0 ? '+' : ''}${m.houseSeatChange}` : '—'}</b>
            </span>
            <span className="num">{m.against != null ? `${m.against.toFixed(1)} pts` : '—'}</span>
            <span className="num">{m.senateSeatChange != null ? `${m.senateSeatChange > 0 ? '+' : ''}${m.senateSeatChange}` : '—'}</span>
          </div>
        ))}
        <div className="sw-hist-row now">
          <span className="sw-year">
            <i className="party-chip" style={{ background: PARTY_COLOR[PRES_PARTY_2026] }} />
            2026
          </span>
          <span className="sw-track">
            <i className="sw-zero" />
            {bar(hc?.change ?? null, PRES_PARTY_2026)}
            <b className="sw-val">{hc ? `${hc.change > 0 ? '+' : ''}${hc.change}` : 'tonight'}</b>
          </span>
          <span className="num">{now != null ? `${now.toFixed(1)} pts` : '—'}</span>
          <span className="num">{sc ? `${sc.change > 0 ? '+' : ''}${sc.change}` : '—'}</span>
        </div>
      </div>
      <div className="sw-foot small muted">
        {closest && now != null ? (
          <>
            Tonight’s House-vote swing against the GOP ({now.toFixed(1)} pts vs the 2024 House vote) is closest to <b>{closest.year}</b> ({closest.against!.toFixed(1)} pts,{' '}
            {closest.houseSeatChange} seats).
          </>
        ) : (
          <>
            Bars: House seats gained or lost by the president’s party. Swing: change in the national House vote from the presidential year before, toward the out-party. 2026 fills in live.
          </>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ statewide comparison table

type SortKey = 'race' | 'vsPrev' | 'vsPres' | 'counted';
function StatewideTable({ races, onHover }: { races: Race[]; onHover: HoverFn }) {
  const [office, setOffice] = useState<Office>('S');
  const [sort, setSort] = useState<SortKey>('race');
  const rows = useMemo(() => {
    const list = races
      .filter((r) => r.office === office)
      .map((r) => {
        const now = dMargin(r);
        const prev = prevFor(r);
        const pres = pres2024For(r);
        const last = raceBaseline.last(r); // null for redrawn districts and non-D-vs-R contests
        const ok = now != null && (r.eevp ?? 0) >= 20;
        return { r, now, prev, pres, vsPrev: ok && last != null ? now! - last : null, vsPres: ok && pres != null ? now! - pres : null };
      });
    const key = (x: (typeof list)[number]) => (sort === 'vsPrev' ? x.vsPrev : sort === 'vsPres' ? x.vsPres : sort === 'counted' ? -(x.r.eevp ?? 0) : null);
    return list.sort((a, b) =>
      sort === 'race' ? a.r.state.localeCompare(b.r.state) || (a.r.district ?? 0) - (b.r.district ?? 0) : (key(a) ?? 999) - (key(b) ?? 999) || a.r.state.localeCompare(b.r.state),
    );
  }, [races, office, sort]);
  const th = (k: SortKey, label: string, title?: string) => (
    <th className={`num sortable ${sort === k ? 'sorted' : ''}`} onClick={() => setSort(k)} title={title}>
      {label}
    </th>
  );
  const note = office === 'H' ? '2024 House result (° = old lines, not compared) · 2024 president in the district' : 'previous race for the same seat · 2024 president in the state';
  return (
    <Panel
      title={`${OFFICE_LABEL[office]} vs last time`}
      className="sw-table"
      note={
        <span className="sw-switches">
          <span className="sw-note-txt">{note}</span>
          <OfficeSwitch value={office} onChange={setOffice} />
        </span>
      }
    >
      <div className="table-scroll">
        <table className="race-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => setSort('race')}>
                Race
              </th>
              {th('counted', 'Tonight', 'D–R margin now (% of expected vote counted)')}
              <th className="num">{office === 'H' ? "'24 House" : 'Last race'}</th>
              {th('vsPrev', 'Shift', 'Tonight minus the seat’s previous result')}
              <th className="num">'24 Pres</th>
              {th('vsPres', 'Shift', 'Tonight minus the 2024 presidential margin')}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, now, prev, pres, vsPrev, vsPres }) => (
              <tr key={r.id} onMouseMove={(e) => onHover(r.id, e)} onMouseLeave={() => onHover(null)}>
                <td className="rt-race">
                  {office === 'H' ? (
                    AT_LARGE_TXT(r)
                  ) : (
                    <>
                      {r.state} <span className="muted small">{office === 'S' ? `Senate${r.special ? ' (sp.)' : ''}` : 'Gov'}</span>
                    </>
                  )}
                </td>
                <td className="num">
                  {now != null ? (
                    <>
                      <b style={{ color: leanColor(now) }}>{fmtLean(now)}</b> <small className="muted">{Math.round(r.eevp ?? 0)}%</small>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td
                  className="num"
                  title={
                    prev
                      ? `${office === 'H' ? '2024 House' : prev.label}${prev.linesChanged ? ' (old lines)' : ''}: ${prevText(prev)}${prev.winner ? `, ${prev.winner.name}` : ''}`
                      : undefined
                  }
                >
                  <span style={{ color: leanColor(prev?.margin) }}>{prevText(prev, true)}</span>{' '}
                  <small className="muted">{office === 'H' ? (prev?.linesChanged ? '°' : '') : `'${String(prev?.year ?? '').slice(2)}`}</small>
                </td>
                <td className="num">{vsPrev != null ? <b style={{ color: leanColor(vsPrev) }}>{fmtLean(vsPrev)}</b> : <span className="muted">—</span>}</td>
                <td className="num" style={{ color: leanColor(pres) }}>
                  {fmtLean(pres)}
                </td>
                <td className="num">{vsPres != null ? <b style={{ color: leanColor(vsPres) }}>{fmtLean(vsPres)}</b> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ biggest movers

function BiggestMovers({ races, onHover }: { races: Race[]; onHover: HoverFn }) {
  const moved = useMemo(
    () =>
      races
        .filter((r) => r.office === 'H' && (r.eevp ?? 0) >= 50)
        .map((r) => {
          const now = dMargin(r);
          const base = pres2024For(r);
          return now != null && base != null ? { r, now, base, s: now - base } : null;
        })
        .filter((x): x is { r: Race; now: number; base: number; s: number } => !!x)
        .sort((a, b) => b.s - a.s),
    [races],
  );
  const list = (items: typeof moved, label: string) => (
    <div className="sw-movers-col">
      <h3 className="small muted">{label}</h3>
      {items.length ? (
        items.map((x) => (
          <div key={x.r.id} className="sw-mover" onMouseMove={(e) => onHover(x.r.id, e)} onMouseLeave={() => onHover(null)}>
            <span title={raceName(x.r)}>
              {x.r.state}-{AT_LARGE.has(x.r.state) ? 'AL' : x.r.district}
            </span>
            <span className="muted small">
              {fmtLean(x.base, 0)} → {fmtLean(x.now, 0)}
            </span>
            <b style={{ color: leanColor(x.s) }}>{fmtLean(x.s)}</b>
          </div>
        ))
      ) : (
        <div className="muted small">—</div>
      )}
    </div>
  );
  return (
    <Panel title="Biggest district shifts" className="sw-movers" note="vs 2024 president · ≥50% counted">
      <div className="sw-movers-body">
        {list(moved.slice(0, 8), 'Toward Democrats')}
        {list([...moved].reverse().slice(0, 8), 'Toward Republicans')}
      </div>
    </Panel>
  );
}

/**
 * Swing dashboard: tonight against the 2024 presidential and House votes and the 2022 midterm,
 * nationally, by state and by district, plus the midterm record of the president's party.
 */
export function SwingView() {
  const racesMap = useElection((s) => s.races);
  const races = useMemo(() => Object.values(racesMap), [racesMap]);
  const { onHover, card } = useRaceHover();
  const areas: Record<string, ReactNode> = {
    tiles: <SwingTiles races={races} />,
    scatter: <DistrictScatter races={races} onHover={onHover} />,
    map: <StateSwingMap races={races} />,
    hist: <MidtermHistory races={races} />,
    table: <StatewideTable races={races} onHover={onHover} />,
    movers: <BiggestMovers races={races} onHover={onHover} />,
  };
  return (
    <div className="swing-view">
      {Object.entries(areas).map(([name, node]) => (
        <div key={name} className="cv-area" style={{ gridArea: name }}>
          <ErrorBoundary label="Widget">{node}</ErrorBoundary>
        </div>
      ))}
      <p className="sw-attrib muted small">
        Baselines: 2024 presidential margins inside each 2026 district from NYT/AP; past results from CNN (2020–2024); district line changes from US Census TIGER/Line; midterm history from
        Wikipedia (CC BY-SA 4.0). Margins are Democratic minus Republican share. Unofficial; see ⚙ Settings → About.
      </p>
      {card}
    </div>
  );
}
