import { useCallback, useState } from 'react';
import { BalanceOfPower } from '../components/BalanceOfPower';
import { FloatingCard } from '../components/FloatingCard';
import { KeyRaces } from '../components/KeyRaces';
import { NewsFeed } from '../components/NewsFeed';
import { PollClosings } from '../components/PollClosings';
import { RaceCard } from '../components/RaceCard';
import { RecentCalls } from '../components/RecentCalls';
import { useElection } from '../store/election';

/** Master dashboard: chamber control, competitive races, projections, poll closings, live feed. */
export function Dashboard() {
  const chambers = useElection((s) => s.chambers);
  const races = useElection((s) => s.races);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  const onHover = useCallback((id: string | null, e?: React.MouseEvent) => {
    setHover(id && e ? { id, x: e.clientX, y: e.clientY } : null);
  }, []);

  const hovered = hover ? races[hover.id] : undefined;

  return (
    <div className="dashboard">
      <div className="dash-bop">
        {chambers?.S && chambers.H && chambers.G ? (
          <>
            <section className="panel">
              <BalanceOfPower c={chambers.S} />
            </section>
            <section className="panel">
              <BalanceOfPower c={chambers.H} />
            </section>
            <section className="panel">
              <BalanceOfPower c={chambers.G} />
            </section>
          </>
        ) : (
          <div className="empty">Connecting…</div>
        )}
      </div>
      <div className="dash-senate">
        <KeyRaces office="S" title="Key Senate races" onHover={onHover} />
      </div>
      <div className="dash-gov">
        <KeyRaces office="G" title="Key Governor races" onHover={onHover} />
      </div>
      <div className="dash-calls">
        <RecentCalls onHover={onHover} />
      </div>
      <div className="dash-closings">
        <PollClosings />
      </div>
      <div className="dash-news">
        <NewsFeed />
      </div>
      {hover && hovered ? (
        <FloatingCard x={hover.x} y={hover.y} pinned={false}>
          <RaceCard race={hovered} />
        </FloatingCard>
      ) : null}
    </div>
  );
}
