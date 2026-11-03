/**
 * CNN results API (Decision Desk). SECONDARY results provider / failover + cross-check.
 *
 *   https://politics.api.cnn.io/results/national-races/2026-{SG|GG|HG}.json
 *
 * - Public, CORS-open JSON, `Cache-Control: max-age=20` behind CloudFront/Fastly.
 * - Used when NYT is stale/down (vote counts), and to surface CNN race calls that land
 *   before AP's. Also supplies per-race poll-closing embargo times.
 */
import type { Candidate, Office, Party } from '../../../shared/src/types.js';
import { OFFICE_LABEL, raceId } from '../../../shared/src/states.js';
import { CNN_BASE, config } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { Poller } from '../lib/poller.js';
import { store } from '../store/store.js';
import type { RaceInput } from '../store/types.js';

interface CnnCandidate {
  candidateId: number;
  firstName: string;
  lastName: string;
  fullName: string;
  majorParty: string;
  partyName: string;
  isIncumbent: boolean;
  voteNum: number;
  votePercentNum: number;
  winner: boolean;
  runoffCandidate?: boolean;
}
interface CnnRace {
  ecKey: string;
  raceType: string;
  stateAbbreviation: string;
  status: string;
  editorialStatus?: string;
  percentReporting: number;
  totalVote: number;
  isSwitch?: boolean;
  uncontested?: boolean;
  candidates: CnnCandidate[];
  raceEmbargo?: { assignedPollsClose?: number };
  voteTimestamp?: string;
  extractedAt?: string;
}

const party = (p: string): Party => (p === 'DEM' ? 'D' : p === 'REP' ? 'R' : 'I');

export function normalizeCnnRace(r: CnnRace): RaceInput | null {
  const office = (r.raceType === 'S' || r.raceType === 'G' || r.raceType === 'H' ? r.raceType : null) as Office | null;
  if (!office) return null;
  const state = r.stateAbbreviation;
  const parts = r.ecKey.split('-');
  const district = office === 'H' ? Number(parts[3]) || 1 : null;
  const candidates: Candidate[] = r.candidates.map((c) => ({
    id: `cnn-${c.candidateId}`,
    name: c.fullName,
    lastName: c.lastName,
    party: party(c.majorParty),
    partyName: c.partyName,
    incumbent: c.isIncumbent,
    votes: c.voteNum ?? 0,
    pct: c.votePercentNum ?? 0,
    winner: !!c.winner,
  }));
  const winner = candidates.find((c) => c.winner);
  const called = !!winner || r.status === 'W';
  return {
    id: raceId(state, office, district),
    office,
    state,
    district,
    special: false,
    title: OFFICE_LABEL[office],
    candidates,
    totalVotes: r.totalVote ?? 0,
    expectedVotes: null,
    eevp: r.percentReporting ?? null,
    precinctsReporting: null,
    precinctsTotal: null,
    called,
    runoff: r.candidates.some((c) => c.runoffCandidate) && !winner,
    calledBy: called ? 'CNN' : null,
    calledAt: called ? (r.voteTimestamp ?? null) : null,
    gainedBy: called && r.isSwitch && winner ? winner.party : null,
    pollClose: r.raceEmbargo?.assignedPollsClose ? new Date(r.raceEmbargo.assignedPollsClose).toISOString() : null,
    uncontested: !!r.uncontested,
    url: null,
    updatedAt: r.voteTimestamp ?? r.extractedAt ?? null,
    source: 'CNN',
  };
}

async function pull(code: string, office: Office): Promise<boolean> {
  const res = await fetchJson<CnnRace[]>(`${CNN_BASE}/${config.electionDate.slice(0, 4)}-${code}.json`, { conditional: true });
  if (!res.changed) {
    store.touch('cnn', [office]);
    return false;
  }
  // The national files also keep contests decided earlier in the year for the same seat (e.g.
  // 2026-HQ-TX-18, the Jan 31 special runoff, already marked won). Drop anything whose polls
  // closed before general-election day, and if a seat still appears twice keep the latest contest.
  const cutoff = Date.parse(`${config.electionDate}T12:00:00Z`);
  const current = (res.data ?? []).filter((r) => !r.raceEmbargo?.assignedPollsClose || r.raceEmbargo.assignedPollsClose >= cutoff);
  const byId = new Map<string, { race: RaceInput; close: number }>();
  for (const r of current) {
    const race = normalizeCnnRace(r);
    if (!race) continue;
    const close = r.raceEmbargo?.assignedPollsClose ?? 0;
    const prev = byId.get(race.id);
    if (!prev || close > prev.close) byId.set(race.id, { race, close });
  }
  const races = [...byId.values()].map((x) => x.race);
  store.ingest({ provider: 'cnn', offices: [office], fetchedAt: Date.now(), races });
  return true;
}

export function startCnn() {
  const p = new Poller({
    id: 'cnn',
    name: 'CNN results',
    role: 'Secondary results + early calls (failover if NYT is stale)',
    hotIntervalS: config.intervals.cnn.hot,
    coldIntervalS: config.intervals.cnn.cold,
    enabled: config.sources.cnn,
    initialDelayMs: 4_000,
    run: async () => {
      const r = await Promise.all([pull('SG', 'S'), pull('GG', 'G'), pull('HG', 'H')]);
      return r.some(Boolean) ? 'updated' : false;
    },
  });
  p.start();
  return [p];
}
