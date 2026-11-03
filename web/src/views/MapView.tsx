import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { Office, Race } from '../../../shared/src/types';
import { BalanceOfPower } from '../components/BalanceOfPower';
import { CustomToolbar } from '../components/CustomToolbar';
import { FloatingCard } from '../components/FloatingCard';
import { RaceCard } from '../components/RaceCard';
import { FILL_MODES, type FillMode } from '../lib/colors';
import { customSummary, decodeMap, useCustomMaps } from '../lib/customMap';
import { projectionSummary } from '../lib/projection';
import { stateName } from '../lib/format';
import { DistrictMap, type DistrictPointer } from '../map/DistrictMap';
import { loadDistricts, type DistrictShape } from '../map/geo';
import { Legend } from '../map/Legend';
import { USMap, type MapPointerEvent } from '../map/USMap';
import { useElection } from '../store/election';

const OFFICE_BY_SLUG: Record<string, Office> = { senate: 'S', governor: 'G', house: 'H' };
const SLUG_BY_OFFICE: Record<Office, string> = { S: 'senate', G: 'governor', H: 'house' };
const OFFICE_NAME: Record<Office, string> = { S: 'Senate', G: 'Governor', H: 'House' };

/** Governors not on the 2026 ballot, for the "prior control" fill. */
const GOV_NOT_UP: Record<string, 'D' | 'R'> = {
  DE: 'D', IN: 'R', KY: 'D', LA: 'R', MS: 'R', MO: 'R', MT: 'R', NJ: 'D', NC: 'D', ND: 'R', UT: 'R', VA: 'D', WA: 'D', WV: 'R',
};

const modesFor = (_office: Office) => FILL_MODES;

interface Pointer {
  key: string;
  state: string;
  clientX: number;
  clientY: number;
}

export function MapView() {
  const { office: slug = 'senate' } = useParams();
  const office = OFFICE_BY_SLUG[slug] ?? 'S';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const races = useElection((s) => s.races);
  const chambers = useElection((s) => s.chambers);
  const flashed = useElection((s) => s.flashed);
  const loaded = useElection((s) => s.loaded);
  const customMap = useCustomMaps((s) => s.maps[office]);
  const paint = useCustomMaps((s) => s.paint);
  const replaceCustom = useCustomMaps((s) => s.replace);
  const brush = useCustomMaps((s) => s.brush);

  const officeRaces = useMemo(() => {
    const out: Record<string, Race> = {};
    for (const r of Object.values(races)) if (r.office === office) out[r.id] = r;
    return out;
  }, [races, office]);
  const raceList = useMemo(() => Object.values(officeRaces), [officeRaces]);

  // Default fill: vote leader once any votes exist for this office, else the forecast.
  const defaultMode = useRef<FillMode | null>(null);
  if (!defaultMode.current && loaded) {
    defaultMode.current = raceList.some((r) => r.totalVotes > 0) ? 'leader' : 'forecast';
  }
  const requested = params.get('fill') as FillMode | null;
  const available = modesFor(office);
  const mode: FillMode = requested && available.some((m) => m.id === requested) ? requested : defaultMode.current || 'forecast';
  const focus = office === 'H' ? params.get('state') : null;

  const setParam = useCallback(
    (k: string, v: string | null) => {
      const p = new URLSearchParams(window.location.search);
      if (v) p.set(k, v);
      else p.delete(k);
      setParams(p, { replace: true });
    },
    [setParams],
  );
  const setMode = useCallback((m: FillMode) => setParam('fill', m), [setParam]);
  const setFocus = useCallback((st: string | null) => setParam('state', st), [setParam]);

  // Import a shared custom map from ?my=... once race definitions are loaded.
  useEffect(() => {
    const enc = params.get('my');
    if (!enc || !raceList.length) return;
    replaceCustom(office, decodeMap(enc, raceList.map((r) => r.id)));
    setParam('my', null);
  }, [params, raceList, office, replaceCustom, setParam]);

  // House geometry is lazy-loaded the first time the House map opens.
  const [districts, setDistricts] = useState<DistrictShape[] | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  useEffect(() => {
    if (office !== 'H' || districts) return;
    loadDistricts()
      .then(setDistricts)
      .catch((e) => setGeoError(String(e)));
  }, [office, districts]);

  const [hover, setHover] = useState<Pointer | null>(null);
  const [pinned, setPinned] = useState<Pointer | null>(null);

  useEffect(() => {
    setPinned(null);
    setHover(null);
  }, [office, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        if (pinned) setPinned(null);
        else if (focus) setFocus(null);
      }
      if (e.key === 'm' || e.key === 'M') {
        const i = available.findIndex((f) => f.id === mode);
        setMode(available[(i + (e.shiftKey ? available.length - 1 : 1)) % available.length].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, setMode, pinned, focus, setFocus, available]);

  // Pointer handling shared by both map types. In custom mode a click paints instead of pinning.
  const keyForState = useCallback((st: string) => `${st}-${office}`, [office]);
  const handleClick = useCallback(
    (p: Pointer) => {
      if (mode === 'custom') {
        if (officeRaces[p.key]) paint(office, p.key, brush || null);
        return;
      }
      setPinned((cur) => (cur?.key === p.key ? null : p));
    },
    [mode, officeRaces, paint, office, brush],
  );
  const handleContext = useCallback(
    (p: Pointer) => {
      if (mode === 'custom' && officeRaces[p.key]) paint(office, p.key, null);
    },
    [mode, officeRaces, paint, office],
  );
  const fromState = (e: MapPointerEvent): Pointer => ({ key: keyForState(e.state), state: e.state, clientX: e.clientX, clientY: e.clientY });
  const fromDistrict = (e: DistrictPointer): Pointer => e;

  const active = pinned ?? hover;
  const activeRace = active ? officeRaces[active.key] : undefined;
  const chamber = chambers?.[office];
  // The tracker follows the color mode: live count (Results), your map, or the seat count
  // implied by the Polymarket / FLIPR / Current view.
  const projection = useMemo(
    () => (chamber && (mode === 'market' || mode === 'forecast' || mode === 'control') ? projectionSummary(chamber, raceList, mode) : null),
    [chamber, raceList, mode],
  );
  const bop = chamber && mode === 'custom' ? customSummary(chamber, raceList, customMap) : (projection?.summary ?? chamber);

  const stats = useMemo(() => {
    const list = focus ? raceList.filter((r) => r.state === focus) : raceList;
    return {
      total: list.length,
      called: list.filter((r) => r.status === 'called').length,
      counting: list.filter((r) => r.status === 'counting').length,
      closed: list.filter((r) => r.status === 'closed').length,
      flips: list.filter((r) => r.flip).length,
    };
  }, [raceList, focus]);

  const focusSummary = useMemo(() => {
    if (!focus) return null;
    const list = raceList.filter((r) => r.state === focus);
    const c = { D: 0, R: 0, I: 0 };
    for (const r of list) {
      const p = r.winner ?? (r.totalVotes > 0 ? r.leader : null);
      if (p) c[p]++;
    }
    const prior = { D: 0, R: 0, I: 0 };
    for (const r of list) if (r.priorParty) prior[r.priorParty]++;
    return { n: list.length, c, prior };
  }, [focus, raceList]);

  return (
    <div className="map-view" onClick={() => setPinned(null)} onContextMenu={(e) => mode === 'custom' && e.preventDefault()}>
      {office === 'H' ? (
        districts ? (
          <DistrictMap
            districts={districts}
            mode={mode}
            races={officeRaces}
            custom={customMap}
            hovered={hover?.key ?? null}
            pinned={pinned?.key ?? null}
            flashed={flashed}
            focus={focus}
            onFocus={(st) => {
              setPinned(null);
              setFocus(st);
            }}
            onHover={(e) => setHover(e ? fromDistrict(e) : null)}
            onClick={(e) => handleClick(fromDistrict(e))}
            onContext={(e) => handleContext(fromDistrict(e))}
          />
        ) : (
          <div className="placeholder">
            <p className="muted">{geoError ? `Could not load district boundaries: ${geoError}` : 'Loading 435 district boundaries…'}</p>
          </div>
        )
      ) : (
        <USMap
          office={office}
          mode={mode}
          races={officeRaces}
          noRaceParty={office === 'G' ? GOV_NOT_UP : undefined}
          hovered={hover ? hover.state : null}
          pinned={pinned ? pinned.state : null}
          flashed={flashed}
          custom={customMap}
          onHover={(e) => setHover(e ? fromState(e) : null)}
          onClick={(e) => handleClick(fromState(e))}
          onContext={(e) => handleContext(fromState(e))}
        />
      )}

      <div className="map-overlay top-left" onClick={(e) => e.stopPropagation()}>
        {bop ? <BalanceOfPower c={bop} custom={mode === 'custom'} view={projection?.view} /> : null}
      </div>

      {focus && focusSummary ? (
        <div className="map-overlay top-center" onClick={(e) => e.stopPropagation()}>
          <button className="back-btn" onClick={() => setFocus(null)} title="Back to the national map (Esc)">
            ← United States
          </button>
          <div className="focus-title">
            {stateName(focus)} <span className="muted">· {focusSummary.n} district{focusSummary.n === 1 ? '' : 's'}</span>
          </div>
          <div className="focus-sub small">
            Before: <b className="d">{focusSummary.prior.D} D</b> – <b className="r">{focusSummary.prior.R} R</b>
            {focusSummary.c.D + focusSummary.c.R + focusSummary.c.I > 0 ? (
              <>
                {' '}
                · Now won/leading: <b className="d">{focusSummary.c.D} D</b> – <b className="r">{focusSummary.c.R} R</b>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="map-overlay top-right" onClick={(e) => e.stopPropagation()}>
        <OfficeSwitch
          office={office}
          onChange={(o) => {
            navigate(`/map/${SLUG_BY_OFFICE[o]}?fill=${mode}`);
          }}
        />
        <div className="seg-control fill-modes" role="tablist" aria-label="Map fill">
          <span className="seg-label">Color by</span>
          {available.map((f) => (
            <button key={f.id} className={`${mode === f.id ? 'on' : ''} ${f.id === 'custom' ? 'custom-mode' : ''}`} onClick={() => setMode(f.id)} title={f.label}>
              {f.short}
            </button>
          ))}
          <kbd title="Press M to cycle">M</kbd>
        </div>
      </div>

      <div className="map-overlay bottom-left" onClick={(e) => e.stopPropagation()}>
        {mode === 'custom' ? <CustomToolbar office={office} races={raceList} /> : <Legend mode={mode} office={office} />}
      </div>

      <div className="map-overlay bottom-right">
        <div className="map-stats">
          <div>
            <b>{stats.total}</b>
            <span>{focus ? stateName(focus) : OFFICE_NAME[office]} races</span>
          </div>
          <div>
            <b>{stats.called}</b>
            <span>called</span>
          </div>
          <div>
            <b>{stats.counting}</b>
            <span>counting</span>
          </div>
          <div>
            <b>{stats.closed}</b>
            <span>awaiting votes</span>
          </div>
          <div>
            <b>{stats.flips}</b>
            <span>flips</span>
          </div>
        </div>
        <div className="hint muted">
          {mode === 'custom'
            ? 'Click to paint with the selected rating · right-click to erase'
            : office === 'H'
              ? 'Hover a district · click to pin · double-click a state to zoom · scroll to zoom, drag to pan · Esc to go back'
              : 'Hover a state for details · click to pin, then open county results · Esc to unpin'}
        </div>
      </div>

      {active ? (
        <FloatingCard x={active.clientX} y={active.clientY} pinned={!!pinned}>
          {activeRace ? (
            <RaceCard race={activeRace} onClose={pinned ? () => setPinned(null) : undefined} onOpen={pinned ? () => navigate(`/race/${activeRace.id}`) : undefined} />
          ) : (
            <div className="race-card no-race-card">
              <div className="rc-title">{stateName(active.state)}</div>
              <div className="rc-sub">
                No {office === 'S' ? 'Senate' : office === 'G' ? 'governor' : 'House'} race in 2026
                {office === 'G' && GOV_NOT_UP[active.state] ? ` · governor is ${GOV_NOT_UP[active.state] === 'D' ? 'a Democrat' : 'a Republican'}` : ''}
              </div>
            </div>
          )}
        </FloatingCard>
      ) : null}
    </div>
  );
}

function OfficeSwitch({ office, onChange }: { office: Office; onChange: (o: Office) => void }) {
  return (
    <div className="seg-control office-switch" role="tablist" aria-label="Race type">
      {(['S', 'G', 'H'] as Office[]).map((o) => (
        <button key={o} className={office === o ? 'on' : ''} onClick={() => onChange(o)}>
          {OFFICE_NAME[o]}
        </button>
      ))}
    </div>
  );
}
