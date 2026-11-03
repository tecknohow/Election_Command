import type { ChamberSummary, Race } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { fmtProb } from '../../lib/format';
import { BalanceOfPower } from '../BalanceOfPower';

/** Balance of power plus the "path to majority" arithmetic and race-status counts. */
export function ChamberHero({ c, races }: { c: ChamberSummary; races: Race[] }) {
  const isSenate = c.office === 'S';
  const dSecured = c.notUp.D + c.won.D + (isSenate ? c.notUp.I + c.won.I : 0);
  const rSecured = c.notUp.R + c.won.R;
  const remaining = c.racesTotal - c.racesCalled;
  const need = c.office === 'G' ? { D: 26, R: 26 } : c.toControl;
  const dNeed = Math.max(0, need.D - dSecured);
  const rNeed = Math.max(0, need.R - rSecured);
  const counts = {
    called: races.filter((r) => r.status === 'called').length,
    counting: races.filter((r) => r.status === 'counting').length,
    closed: races.filter((r) => r.status === 'closed').length,
    upcoming: races.filter((r) => r.status === 'upcoming').length,
  };
  const netD = c.flips.toD - c.flips.toR;
  const goal = c.office === 'G' ? 'a majority of governorships' : 'control';
  const pathLine = (party: 'D' | 'R', n: number) => {
    const name = party === 'D' ? (isSenate ? 'Democrats (+ind.)' : 'Democrats') : 'Republicans';
    if (n === 0) return <><b style={{ color: PARTY_COLOR[party] }}>{name}</b> have clinched {goal}</>;
    if (n > remaining) return <><b style={{ color: PARTY_COLOR[party] }}>{name}</b> can no longer reach {goal}</>;
    return (
      <>
        <b style={{ color: PARTY_COLOR[party] }}>{name}</b> need <b>{n}</b> of the <b>{remaining}</b> uncalled races ({Math.round((n / Math.max(1, remaining)) * 100)}%)
      </>
    );
  };
  const pm = c.market?.byParty;

  return (
    <section className="panel hero">
      <BalanceOfPower c={c} />
      <div className="hero-path">
        <div>{pathLine('D', dNeed)}</div>
        <div>{pathLine('R', rNeed)}</div>
      </div>
      <div className="hero-stats">
        <div>
          <b>{counts.called}</b>
          <span>called</span>
        </div>
        <div>
          <b>{counts.counting}</b>
          <span>counting</span>
        </div>
        <div>
          <b>{counts.closed}</b>
          <span>polls closed</span>
        </div>
        <div>
          <b>{counts.upcoming}</b>
          <span>polls open</span>
        </div>
        <div>
          <b style={{ color: netD > 0 ? PARTY_COLOR.D : netD < 0 ? PARTY_COLOR.R : undefined }}>{netD === 0 ? '±0' : netD > 0 ? `D+${netD}` : `R+${-netD}`}</b>
          <span>net flips</span>
        </div>
        {pm && (pm.D != null || pm.R != null) ? (
          <div>
            <b style={{ color: (pm.D ?? 0) >= (pm.R ?? 0) ? PARTY_COLOR.D : PARTY_COLOR.R }}>{(pm.D ?? 0) >= (pm.R ?? 0) ? `D ${fmtProb(pm.D)}` : `R ${fmtProb(pm.R)}`}</b>
            <span>Polymarket control</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
