import { useMemo, type ReactNode } from 'react';
import type { Office, Party, Race } from '../../../shared/src/types';
import { BopTimeline } from '../components/chamber/BopTimeline';
import { ChamberHero } from '../components/chamber/ChamberHero';
import { Delegations } from '../components/chamber/Delegations';
import { FlipsPanel } from '../components/chamber/FlipsPanel';
import { Hemicycle } from '../components/chamber/Hemicycle';
import { Incumbents } from '../components/chamber/Incumbents';
import { PopularVote } from '../components/chamber/PopularVote';
import { RaceTable } from '../components/chamber/RaceTable';
import { SeatLadder } from '../components/chamber/SeatLadder';
import { SplitTicket } from '../components/chamber/SplitTicket';
import { TileMap } from '../components/chamber/TileMap';
import { useRaceHover } from '../components/chamber/useRaceHover';
import { WatchList } from '../components/chamber/WatchList';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { NewsFeed } from '../components/NewsFeed';
import { useElection } from '../store/election';

const GOV_NOT_UP: Record<string, Party> = {
  DE: 'D', IN: 'R', KY: 'D', LA: 'R', MS: 'R', MO: 'R', MT: 'R', NJ: 'D', NC: 'D', ND: 'R', UT: 'R', VA: 'D', WA: 'D', WV: 'R',
};

const TITLES: Record<Office, string> = { S: 'Senate', H: 'House', G: 'Governor' };

/**
 * Per-chamber desk. All three share one frame: hero (BoP + path to majority), a signature
 * visual, a context widget, the office-filtered feed, races to watch, the full race table,
 * flips, and side panels. Widget choice per chamber:
 *   Senate    — path-to-51 seat ladder, seats timeline, incumbents
 *   House     — 435-seat hemicycle, national popular vote, state delegations, seats timeline
 *   Governors — 50-state tile map, ticket splitting (Senate vs Governor), incumbents, timeline
 */
export function ChamberView({ office }: { office: Office }) {
  const races = useElection((s) => s.races);
  const chambers = useElection((s) => s.chambers);
  const { onHover, card } = useRaceHover();

  const list = useMemo(() => Object.values(races).filter((r) => r.office === office), [races, office]);
  const byState = useMemo(() => {
    const m: Record<string, Race> = {};
    for (const r of list) m[r.state] = r;
    return m;
  }, [list]);
  const chamber = chambers?.[office];
  if (!chamber) return <div className="empty">Connecting…</div>;

  const areas: Record<string, ReactNode> = {
    hero: <ChamberHero c={chamber} races={list} />,
    watch: <WatchList races={list} onHover={onHover} />,
    table: <RaceTable races={list} onHover={onHover} defaultFilter={office === 'H' ? 'competitive' : 'all'} />,
    flips: <FlipsPanel races={list} onHover={onHover} />,
    feed: <NewsFeed office={office} title={`${TITLES[office]} feed`} />,
  };
  if (office === 'S') {
    areas.sig = <SeatLadder chamber={chamber} races={list} onHover={onHover} />;
    areas.ctx = <BopTimeline office={office} chamber={chamber} />;
    areas.side1 = <Incumbents races={list} onHover={onHover} />;
  } else if (office === 'H') {
    areas.sig = <Hemicycle chamber={chamber} races={list} onHover={onHover} />;
    areas.ctx = <PopularVote races={list} />;
    areas.side1 = <Delegations races={list} />;
    areas.side2 = <BopTimeline office={office} chamber={chamber} />;
  } else {
    areas.sig = <TileMap races={byState} notUp={GOV_NOT_UP} onHover={onHover} title="Governorships" />;
    areas.ctx = <SplitTicket races={races} onHover={onHover} />;
    areas.side1 = <Incumbents races={list} onHover={onHover} />;
    areas.side2 = <BopTimeline office={office} chamber={chamber} />;
  }

  return (
    <div className={`chamber-view chamber-${office}`}>
      {Object.entries(areas).map(([name, node]) => (
        <div key={name} className="cv-area" style={{ gridArea: name }}>
          <ErrorBoundary label="Widget">{node}</ErrorBoundary>
        </div>
      ))}
      {card}
    </div>
  );
}
