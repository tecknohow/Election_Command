import { useState } from 'react';
import type { Office, Race } from '../../../shared/src/types';
import { CUSTOM_RATINGS, inkFor } from '../lib/colors';
import { SEED_LABEL, encodeMap, seedMap, useCustomMaps, type SeedSource } from '../lib/customMap';

/** Brush palette + tools for the "build your own map" mode. */
export function CustomToolbar({ office, races }: { office: Office; races: Race[] }) {
  const brush = useCustomMaps((s) => s.brush);
  const setBrush = useCustomMaps((s) => s.setBrush);
  const map = useCustomMaps((s) => s.maps[office]);
  const replace = useCustomMaps((s) => s.replace);
  const [seed, setSeed] = useState<SeedSource>('forecast');
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const assigned = races.filter((r) => map[r.id]).length;
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('fill', 'custom');
    url.searchParams.set('my', encodeMap(map, races.map((r) => r.id)));
    try {
      await navigator.clipboard.writeText(url.toString());
      flash('Share link copied');
    } catch {
      window.history.replaceState(null, '', url.toString());
      flash('Link is in the address bar');
    }
  };

  return (
    <div className="custom-toolbar">
      <div className="ct-row">
        <span className="ct-title">Build your map</span>
        <span className="muted small">
          {assigned}/{races.length} assigned · click to paint · right-click to erase
        </span>
      </div>
      <div className="ct-brushes" role="radiogroup" aria-label="Rating brush">
        {CUSTOM_RATINGS.map((r) => (
          <button
            key={r.code}
            role="radio"
            aria-checked={brush === r.code}
            className={`ct-brush ${brush === r.code ? 'on' : ''}`}
            style={{ background: r.fill, color: inkFor(r.fill) }}
            onClick={() => setBrush(r.code)}
            title={r.label}
          >
            {r.label}
          </button>
        ))}
        <button className={`ct-brush eraser ${brush === '' ? 'on' : ''}`} onClick={() => setBrush('')} title="Erase">
          Erase
        </button>
      </div>
      <div className="ct-row ct-tools">
        <label>
          Start from&nbsp;
          <select value={seed} onChange={(e) => setSeed(e.target.value as SeedSource)}>
            {(Object.keys(SEED_LABEL) as SeedSource[]).map((k) => (
              <option key={k} value={k}>
                {SEED_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            replace(office, seedMap(seed, races));
            flash(`Loaded ${SEED_LABEL[seed].toLowerCase()}`);
          }}
        >
          Apply
        </button>
        {confirmClear ? (
          <>
            <span className="small">Clear all?</span>
            <button
              className="danger"
              onClick={() => {
                replace(office, {});
                setConfirmClear(false);
              }}
            >
              Yes, clear
            </button>
            <button onClick={() => setConfirmClear(false)}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmClear(true)} disabled={!assigned}>
            Clear
          </button>
        )}
        <button onClick={copyLink} disabled={!assigned}>
          Copy share link
        </button>
        {msg ? <span className="ct-msg">{msg}</span> : null}
      </div>
    </div>
  );
}
