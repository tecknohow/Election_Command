import { useCallback, useState } from 'react';
import { useElection } from '../../store/election';
import { FloatingCard } from '../FloatingCard';
import { RaceCard } from '../RaceCard';

export type HoverFn = (raceId: string | null, e?: React.MouseEvent) => void;

/** Shared hover-card state for dashboard widgets: any widget calls onHover(raceId, event). */
export function useRaceHover() {
  const races = useElection((s) => s.races);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const onHover: HoverFn = useCallback((id, e) => setHover(id && e ? { id, x: e.clientX, y: e.clientY } : null), []);
  const race = hover ? races[hover.id] : undefined;
  const card =
    hover && race ? (
      <FloatingCard x={hover.x} y={hover.y} pinned={false}>
        <RaceCard race={race} />
      </FloatingCard>
    ) : null;
  return { onHover, card };
}
