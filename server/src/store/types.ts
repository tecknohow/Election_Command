import type { Candidate, MarketData, Office, Party, Rating } from '../../../shared/src/types.js';

/** Normalized output of a results provider (NYT, CNN, simulator) for one race. */
export interface RaceInput {
  id: string;
  office: Office;
  state: string;
  district: number | null;
  special: boolean;
  title: string;
  candidates: Candidate[];
  totalVotes: number;
  expectedVotes: number | null;
  eevp: number | null;
  precinctsReporting: number | null;
  precinctsTotal: number | null;
  called: boolean;
  runoff: boolean;
  calledBy: string | null;
  calledAt: string | null;
  /** Party the provider says gained the seat (flip), if it reports it. */
  gainedBy: Party | null;
  pollClose: string | null;
  uncontested: boolean;
  rating?: Rating;
  /** 2024 presidential margin in this geography (D minus R, pct pts) — simulator baseline. */
  baselineMargin?: number | null;
  /** Ranked-choice tabulation, when the provider reports it. */
  rcv?: boolean;
  /** NYT/AP: the state has certified the result. */
  certified?: boolean;
  /**
   * NYT live model: projected final margin of the candidate currently leading the count, as
   * quantiles (fractions; median at index 2). Negative median = the runner-up is projected to win.
   */
  model?: { quantiles: number[] } | null;
  url: string | null;
  updatedAt: string | null;
  source: string;
}

export interface ProviderBatch {
  provider: 'nyt' | 'cnn' | 'sim';
  /** Which offices this batch is authoritative for. */
  offices: Office[];
  fetchedAt: number;
  races: RaceInput[];
}

export interface Enrichment {
  flipr?: Rating;
  cook?: Rating;
  priorParty?: Party;
  incumbentName?: string;
  /** Special election (from Wikipedia), for providers that don't flag it (CNN). */
  special?: boolean;
}

export type MarketMap = Map<string, MarketData>;
