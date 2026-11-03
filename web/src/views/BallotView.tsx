import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BallotMeasure } from '../../../shared/src/types';
import { FloatingCard } from '../components/FloatingCard';
import { MEASURE_COLOR, NEUTRAL, inkFor } from '../lib/colors';
import { fmtEt, fmtNum, safeHref, stateName } from '../lib/format';
import { CALLOUTS, NATION_OUTLINE, STATE_BORDERS, STATE_SHAPES, VIEWBOX } from '../map/geo';
import { useElection } from '../store/election';

type TypeFilter = 'amend' | 'all';
type StatusFilter = 'all' | 'counting' | 'called' | 'pending';
type SortKey = 'state' | 'close' | 'recent';

/** Neutral sequential ramp for "number of measures" (no party connotation). */
const COUNT_RAMP = ['#232a38', '#313b51', '#45516c', '#5d6b8b', '#7d8bab'];
const countFill = (n: number) => (n <= 0 ? NEUTRAL.noRace : COUNT_RAMP[Math.min(COUNT_RAMP.length - 1, n === 1 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4)]);

const ORIGIN_LABEL: Record<string, string> = { Legislature: 'Legislative referral', Citizens: 'Citizen initiative' };

function YesNoBar({ m }: { m: BallotMeasure }) {
  const yes = m.choices.find((c) => c.side === 'yes');
  const no = m.choices.find((c) => c.side === 'no');
  const counted = m.totalVotes > 0;
  return (
    <div className="yn">
      <div className="yn-labels">
        <span style={{ color: MEASURE_COLOR.yes }}>
          {yes?.winner ? '✔ ' : ''}
          {(yes?.label ?? 'Yes').toUpperCase()} {counted && yes ? `${yes.pct.toFixed(1)}%` : ''}
        </span>
        <span style={{ color: MEASURE_COLOR.no }}>
          {counted && no ? `${no.pct.toFixed(1)}%` : ''} {(no?.label ?? 'No').toUpperCase()}
          {no?.winner ? ' ✔' : ''}
        </span>
      </div>
      <div className="yn-bar">
        <div className="yn-fill yes" style={{ width: `${counted ? (yes?.pct ?? 0) : 0}%`, background: MEASURE_COLOR.yes, opacity: m.result === 'failed' ? 0.55 : 1 }} />
        <div className="yn-fill no" style={{ width: `${counted ? (no?.pct ?? 0) : 0}%`, background: MEASURE_COLOR.no, opacity: m.result === 'passed' ? 0.55 : 1 }} />
        <div className="yn-threshold" style={{ left: `${m.threshold}%` }} title={`${m.threshold}% needed to pass`} />
        {counted && m.eevp != null ? <div className="rr-eevp" style={{ width: `${Math.min(100, m.eevp)}%` }} /> : null}
      </div>
      {m.threshold !== 50 ? <div className="yn-note">{m.threshold}% supermajority required</div> : null}
    </div>
  );
}

function StatusBadge({ m }: { m: BallotMeasure }) {
  if (m.result === 'passed')
    return (
      <span className="badge m-passed" style={{ background: MEASURE_COLOR.yes }}>
        ✔ PASSED
      </span>
    );
  if (m.result === 'failed')
    return (
      <span className="badge m-failed" style={{ background: MEASURE_COLOR.no }}>
        ✖ FAILED
      </span>
    );
  if (m.status === 'counting') return <span className="badge status-counting">{m.eevp != null ? `${Math.round(m.eevp)}% in` : 'Counting'}</span>;
  if (m.status === 'closed') return <span className="badge status-closed">Polls closed</span>;
  return <span className="badge">{m.pollClose ? `Closes ${fmtEt(m.pollClose)}` : 'Nov 3'}</span>;
}

function MeasureCard({ m, flash }: { m: BallotMeasure; flash: boolean }) {
  return (
    <article className={`measure-card ${m.live ? '' : 'catalog'} ${m.result ?? ''} ${flash ? 'flash' : ''}`}>
      <header className="mc-head">
        <span className="mc-state">{m.state}</span>
        <span className="mc-code">{m.code ?? stateName(m.state)}</span>
        <span className="mc-tags">
          {m.type === 'constitutional' ? <span className="tag amend">AMENDMENT</span> : m.type === 'statute' ? <span className="tag statute">STATUTE</span> : null}
          {m.origin ? <span className="tag origin">{ORIGIN_LABEL[m.origin] ?? m.origin}</span> : null}
        </span>
        <StatusBadge m={m} />
      </header>
      <h3 className="mc-title">
        {safeHref(m.ballotpediaUrl ?? m.wikipediaUrl) ? (
          <a
            href={safeHref(m.ballotpediaUrl ?? m.wikipediaUrl)}
            target="_blank"
            rel="noreferrer noopener"
            title={m.ballotpediaUrl ? 'Open this measure on Ballotpedia' : 'Open this measure on Wikipedia'}
          >
            {m.title}
            <span className="mc-ext" aria-hidden="true">
              {' '}
              ↗
            </span>
          </a>
        ) : (
          m.title
        )}
      </h3>
      {m.description && m.description !== m.title ? (
        <p className="mc-desc" title={m.description}>
          {m.description}
        </p>
      ) : null}
      {m.live ? (
        <>
          <YesNoBar m={m} />
          <footer className="mc-foot">
            <span>{m.totalVotes ? `${fmtNum(m.totalVotes)} votes` : m.status === 'upcoming' ? `Polls close ${fmtEt(m.pollClose)} ET` : 'Awaiting first results'}</span>
            <span className="muted">
              {m.topics.slice(0, 2).join(' · ')}
              {m.calledBy ? ` · called by ${m.calledBy}` : ''} · {m.source}
            </span>
          </footer>
        </>
      ) : (
        <footer className="mc-foot catalog-note">
          <span>No live results feed yet. NYT/AP state results are picked up automatically when published.</span>
          <span className="muted">{m.topics.slice(0, 2).join(' · ')}</span>
        </footer>
      )}
    </article>
  );
}

function BallotMap({ counts, selected, onSelect, onHover }: { counts: Record<string, number>; selected: string | null; onSelect: (st: string) => void; onHover: (st: string | null, e?: React.MouseEvent) => void }) {
  return (
    <svg className="ballot-map" viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`} preserveAspectRatio="xMidYMid meet">
      {STATE_SHAPES.map((s) => (
        <path
          key={s.postal}
          d={s.d}
          fill={countFill(counts[s.postal] ?? 0)}
          className={`state ${counts[s.postal] ? 'has-race' : 'no-race'} ${selected === s.postal ? 'selected' : ''}`}
          onMouseMove={(e) => onHover(s.postal, e)}
          onMouseLeave={() => onHover(null)}
          onClick={() => counts[s.postal] && onSelect(s.postal)}
        />
      ))}
      <path d={STATE_BORDERS} className="state-borders" />
      <path d={NATION_OUTLINE} className="nation-outline" />
      {STATE_SHAPES.filter((s) => s.postal === selected).map((s) => (
        <path key="sel" d={s.d} className="state-highlight pinned" />
      ))}
      {STATE_SHAPES.filter((s) => !CALLOUTS.includes(s.postal) && counts[s.postal]).map((s) => (
        <text key={s.postal} x={s.centroid[0]} y={s.centroid[1]} dy="0.35em" textAnchor="middle" className="state-label" fill={inkFor(countFill(counts[s.postal]))}>
          {s.postal} {counts[s.postal]}
        </text>
      ))}
      {CALLOUTS.filter((p) => counts[p]).map((postal, i) => (
        <g key={postal} className="callout has-race" onClick={() => onSelect(postal)} onMouseMove={(e) => onHover(postal, e)} onMouseLeave={() => onHover(null)}>
          <rect x={985} y={150 + i * 27} width={50} height={20} rx={3} fill={countFill(counts[postal])} className="callout-box" />
          <text x={1010} y={160 + i * 27} dy="0.35em" textAnchor="middle" className="state-label" fill="#e8ebf2">
            {postal} {counts[postal]}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function BallotView() {
  const measures = useElection((s) => s.measures);
  const flashed = useElection((s) => s.flashed);
  const [params, setParams] = useSearchParams();
  const type: TypeFilter = params.get('type') === 'amend' ? 'amend' : 'all';
  const status = (params.get('status') as StatusFilter) || 'all';
  const sort = (params.get('sort') as SortKey) || 'state';
  const topic = params.get('topic');
  const stateSel = params.get('state');
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<{ st: string; x: number; y: number } | null>(null);

  const setParam = useCallback(
    (k: string, v: string | null) => {
      const p = new URLSearchParams(window.location.search);
      if (v) p.set(k, v);
      else p.delete(k);
      setParams(p, { replace: true });
    },
    [setParams],
  );

  const all = useMemo(() => Object.values(measures), [measures]);
  const typed = useMemo(() => all.filter((m) => type === 'all' || m.type === 'constitutional'), [all, type]);
  const topics = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of typed) for (const t of m.topics) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [typed]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = typed.filter((m) => {
      if (stateSel && m.state !== stateSel) return false;
      if (topic && !m.topics.includes(topic)) return false;
      if (status === 'counting' && m.status !== 'counting') return false;
      if (status === 'called' && !m.result) return false;
      if (status === 'pending' && (m.result || m.status === 'counting')) return false;
      if (q && !`${m.title} ${m.description ?? ''} ${m.code ?? ''} ${stateName(m.state)}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const byState = (a: BallotMeasure, b: BallotMeasure) =>
      a.state.localeCompare(b.state) ||
      Number(!a.code) - Number(!b.code) ||
      (a.code ?? '').localeCompare(b.code ?? '', undefined, { numeric: true }) ||
      a.title.localeCompare(b.title);
    if (sort === 'close') {
      const closeness = (m: BallotMeasure) => (m.yesPct == null ? 999 : m.result ? 500 + Math.abs(m.yesPct - m.threshold) : Math.abs(m.yesPct - m.threshold));
      return list.sort((a, b) => closeness(a) - closeness(b) || byState(a, b));
    }
    if (sort === 'recent') return list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || byState(a, b));
    return list.sort(byState);
  }, [typed, stateSel, topic, status, query, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of typed) if (!topic || m.topics.includes(topic)) c[m.state] = (c[m.state] ?? 0) + 1;
    return c;
  }, [typed, topic]);

  // A selected state (or topic) that the current view no longer offers can't be clicked off the
  // map / chip row, so drop it. Waits for measures to load so a deep-linked ?state= survives.
  useEffect(() => {
    if (!all.length) return;
    const topicGone = !!topic && !topics.some(([t]) => t === topic);
    const effTopic = topicGone ? null : topic;
    const stateGone = !!stateSel && !typed.some((m) => m.state === stateSel && (!effTopic || m.topics.includes(effTopic)));
    if (!topicGone && !stateGone) return;
    const p = new URLSearchParams(window.location.search);
    if (topicGone) p.delete('topic');
    if (stateGone) p.delete('state');
    setParams(p, { replace: true });
  }, [all.length, typed, topics, topic, stateSel, setParams]);

  const summary = useMemo(
    () => ({
      total: typed.length,
      live: typed.filter((m) => m.live).length,
      called: typed.filter((m) => m.result).length,
      passed: typed.filter((m) => m.result === 'passed').length,
      failed: typed.filter((m) => m.result === 'failed').length,
      counting: typed.filter((m) => m.status === 'counting').length,
      states: new Set(typed.map((m) => m.state)).size,
    }),
    [typed],
  );

  const recent = useMemo(
    () =>
      all
        .filter((m) => m.result)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, 30),
    [all],
  );
  const now = Date.now();
  const hoverList = hover ? typed.filter((m) => m.state === hover.st) : [];

  return (
    <div className="ballot-view">
      <div className="bv-head">
        <div className="tiles">
          <div className="tile">
            <b>{summary.total}</b>
            <span>{type === 'amend' ? 'Constitutional amendments' : 'Statewide measures'}</span>
          </div>
          <div className="tile">
            <b>{summary.states}</b>
            <span>States</span>
          </div>
          <div className="tile">
            <b>{summary.live}</b>
            <span>With live results</span>
          </div>
          <div className="tile">
            <b>{summary.counting}</b>
            <span>Counting</span>
          </div>
          <div className="tile">
            <b>
              {summary.called}
              <small>/{summary.total}</small>
            </b>
            <span>Called</span>
          </div>
          <div className="tile">
            <b style={{ color: MEASURE_COLOR.yes }}>{summary.passed}</b>
            <span>✔ Passed</span>
          </div>
          <div className="tile">
            <b style={{ color: MEASURE_COLOR.no }}>{summary.failed}</b>
            <span>✖ Failed</span>
          </div>
        </div>
        <div className="bv-filters">
          <div className="seg-control">
            <button className={type === 'all' ? 'on' : ''} onClick={() => setParam('type', null)}>
              All measures
            </button>
            <button className={type === 'amend' ? 'on' : ''} onClick={() => setParam('type', 'amend')}>
              Constitutional amendments
            </button>
          </div>
          <div className="seg-control">
            {(['all', 'counting', 'called', 'pending'] as StatusFilter[]).map((s) => (
              <button key={s} className={status === s ? 'on' : ''} onClick={() => setParam('status', s === 'all' ? null : s)}>
                {s === 'all' ? 'Any status' : s === 'pending' ? 'Not yet counting' : s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <select value={sort} onChange={(e) => setParam('sort', e.target.value === 'state' ? null : e.target.value)} className="bv-select">
            <option value="state">Sort: state</option>
            <option value="close">Sort: closest to threshold</option>
            <option value="recent">Sort: recently updated</option>
          </select>
          <input className="bv-search" placeholder="Search measures…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {stateSel ? (
            <button className="chip on" onClick={() => setParam('state', null)}>
              {stateName(stateSel)} ✕
            </button>
          ) : null}
        </div>
        <div className="chips topic-chips">
          <button className={`chip ${!topic ? 'on' : ''}`} onClick={() => setParam('topic', null)}>
            All topics
          </button>
          {topics.map(([t, n]) => (
            <button key={t} className={`chip ${topic === t ? 'on' : ''}`} onClick={() => setParam('topic', topic === t ? null : t)}>
              {t} <span className="muted">{n}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="bv-side">
        <section className="panel bv-map-panel">
          <div className="panel-head">
            <h2>Measures by state</h2>
            <span className="muted small">click a state to filter</span>
          </div>
          <BallotMap
            counts={counts}
            selected={stateSel}
            onSelect={(st) => setParam('state', stateSel === st ? null : st)}
            onHover={(st, e) => setHover(st && e ? { st, x: e.clientX, y: e.clientY } : null)}
          />
        </section>
        <section className="panel bv-recent">
          <div className="panel-head">
            <h2>Results</h2>
            <span className="muted small">{recent.length ? `${recent.length} decided` : 'none decided yet'}</span>
          </div>
          <ul className="calls-list">
            {recent.map((m) => (
              <li key={m.id} className="measure-call">
                <i className="party-chip" style={{ background: m.result === 'passed' ? MEASURE_COLOR.yes : MEASURE_COLOR.no }} />
                <span className="cl-race">
                  {m.state} {m.code}
                </span>
                <span className="cl-name" title={m.title}>
                  {m.title}
                </span>
                <span className="badge" style={{ background: m.result === 'passed' ? MEASURE_COLOR.yes : MEASURE_COLOR.no, color: '#0b0e14' }}>
                  {m.result === 'passed' ? '✔ PASS' : '✖ FAIL'}
                </span>
                <span className="cl-time muted">{m.yesPct != null ? `${m.yesPct.toFixed(0)}% yes` : ''}</span>
              </li>
            ))}
            {!recent.length ? <li className="empty">Results appear here as measures are called</li> : null}
          </ul>
        </section>
      </div>

      <p className="bv-attrib muted small">
        Measure names and links:{' '}
        <a href="https://ballotpedia.org/" target="_blank" rel="noreferrer noopener">
          Ballotpedia
        </a>{' '}
        (Wikipedia where Ballotpedia has no page). Measure list, numbers and descriptions:{' '}
        <a href="https://en.wikipedia.org/wiki/2026_United_States_ballot_measures" target="_blank" rel="noreferrer noopener">
          Wikipedia
        </a>{' '}
        (CC BY-SA 4.0) and NYT/AP. Results: CNN and NYT/AP. Unofficial; see ⚙ Settings → About.
      </p>
      <section className="bv-cards">
        {filtered.map((m) => (
          <MeasureCard key={m.id} m={m} flash={!!flashed[m.id] && now - flashed[m.id] < 2500} />
        ))}
        {!filtered.length ? <div className="empty">{all.length ? 'No measures match these filters' : 'Loading ballot measures…'}</div> : null}
      </section>

      {hover && hoverList.length ? (
        <FloatingCard x={hover.x} y={hover.y} pinned={false}>
          <div className="race-card">
            <div className="rc-title">
              {stateName(hover.st)} <span className="rc-office">{hoverList.length} measures</span>
            </div>
            <ul className="hover-measures">
              {hoverList.slice(0, 10).map((m) => (
                <li key={m.id}>
                  <StatusBadge m={m} /> <b>{m.code ?? ''}</b> {m.title}
                </li>
              ))}
              {hoverList.length > 10 ? <li className="muted">+{hoverList.length - 10} more</li> : null}
            </ul>
          </div>
        </FloatingCard>
      ) : null}
    </div>
  );
}
