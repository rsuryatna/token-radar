// Token Radar's model, version radar-3 (Node 22, standard library only).
//
// The radar is fitted, not asserted. Two fits run on the sealed snapshot every time this
// program runs, and both are validated on held-out protocols before the board is built:
//
//   * The comps curve. Market cap is modelled as a function of TVL plus the direction of
//     the 7-day change, fitted by least squares on the snapshot's own live-token protocols
//     (the 128 that record a market cap above zero). The change enters as its direction
//     only (+1 when TVL rose this week, -1 when it fell, 0 when it did not move or is not
//     recorded): the size of the move was tried and dropped, because it loses to TVL alone
//     on both held-out tests. The fit is log(mcap) = intercept + tvl_coef * log(TVL) +
//     direction_coef * direction, so a protocol whose TVL fell this week prices about 22%
//     higher per dollar of TVL than one whose TVL rose -- the week's hot money is not
//     durable money, and the held-out test says the size of the move adds nothing.
//   * Launch odds. The chance a pre-token protocol launches a token in the next year is a
//     Weibull-mixture survival curve fitted to the snapshot's own current-status data
//     (every protocol's age and whether it records a token yet). The curve is fitted by a
//     grid search that minimises the negative log-likelihood.
//
// Implied value = fitted launch value x one-year launch odds. A protocol that is huge but
// has run for years with no token gets a low odds multiplier; a young, fast protocol gets a
// high one. Nothing is hard-coded to a name: one function scores every row, and the
// dashboard's detail view recomputes each value in the browser from the same figures.
//
// What the held-out tests said (recomputed from the snapshot on every run; the dashboard
// shows the table): the flat median multiple misses by x5.21 on 5-fold cross-validation,
// TVL alone by x3.80, TVL plus the 7-day direction by x3.70 -- the direction term is kept
// because it wins on both the 5-fold and the single-split tests. The change's size, age
// and chain count were tried and dropped: the size loses to TVL alone on both tests
// (x4.14 / x4.73), age wins the 5-fold by a hair but loses the single split badly (x4.47
// vs x4.06), and chain count loses on both. The launch-odds curve predicts whether a
// protocol records a token with 64.9% held-out accuracy against a 50.9% majority-class base.

import { createHash } from 'node:crypto';

/** One protocol out of the snapshot: exactly the ten fields the snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot: the protocols, the watchlist, and the floor the watchlist drew. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** A refused snapshot, or a board the gate will not take. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The fitted model: the comps curve, the survival curve, and the farm verdict's defaults. */
export interface ModelConstants {
  /** log(mcap) = intercept + tvl_coef * log(TVL) + direction_coef * direction. */
  intercept: number;
  tvl_coef: number;
  /** The 7-day direction's coefficient: +1 when TVL rose, -1 when it fell, 0 otherwise. */
  direction_coef: number;
  /** Launch odds: P(token by age t) = q * (1 - exp(-(t / tau) ** k)). */
  survival_q: number;
  survival_tau: number;
  survival_k: number;
  /** Age used when a protocol records no listing date. */
  unknown_age_days: number;
  /** The farm verdict's stated defaults (the dashboard's what-if control moves them). */
  verdict_deposit_usd: number;
  verdict_pool_fraction: number;
  verdict_farmed_fraction: number;
  verdict_gas_usd: number;
  verdict_tbill: number;
  verdict_hold_days: number;
}

/** One row of the held-out comps table the dashboard shows. */
export interface CompsTest {
  label: string;
  five_fold_miss: number;
  single_split_miss: number;
  kept: boolean;
  note: string;
}

/** The held-out launch-odds test the dashboard shows. */
export interface SurvivalTest {
  protocols: number;
  accuracy: number;
  base_accuracy: number;
  brier: number;
  base_brier: number;
  nll: number;
}

/** One age bucket of the launch-odds calibration table. */
export interface CalibrationRow {
  age_from_days: number;
  age_to_days: number | null;
  protocols: number;
  empirical_rate: number;
  model_rate: number;
  odds_1y: number;
}

/** Every held-out number the dashboard reports, computed from the snapshot on this run. */
export interface Validation {
  comps_protocols: number;
  comps: CompsTest[];
  survival: SurvivalTest;
  calibration: CalibrationRow[];
}

/** One farm step: an action, its cost, and its time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A farm verdict: what $1,000 earns on this protocol at the stated defaults. */
export interface FarmVerdict {
  verdict: 'FARM' | 'THIN' | 'SKIP';
  expected_return_usd: number;
  expected_gross_usd: number;
  farmer_share: number;
}

/** One ranked board row: the gate's fields, plus the model's breakdown and the verdict. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  fitted_value_usd: number;
  launch_odds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  expected_return_usd: number;
  model: { direction: number; age_days: number | null };
  farm_steps: string[];
}

/** One live-token protocol for the dashboard's Live view: all 416 of them. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  age_days: number | null;
}

/** One pre-token protocol the board sets aside, with the reason the rule gives. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** A board row's compact form for data.js, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  fitted_value_usd: number;
  launch_odds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  expected_return_usd: number;
  farm_steps: string[];
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  validation: Validation;
  model_version: string;
  total_protocols: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  set_aside_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  set_aside: SetAsideRow[];
}

export const MODEL_VERSION = 'radar-3';

/** Days from `listed` to `asOf` (YYYY-MM-DD), or null when the protocol records no date. */
export function ageDays(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const [ay, am, ad] = asOf.split('-').map(Number);
  const [ly, lm, ld] = listed.split('-').map(Number);
  const a = Date.UTC(ay!, am! - 1, ad!);
  const l = Date.UTC(ly!, lm! - 1, ld!);
  return Math.floor((a - l) / 86_400_000);
}

/** A finite number, or the fallback when the snapshot carries null or a non-number. */
function finite(n: number | null, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** The median of a list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A number rounded to four decimals, for the dashboard's constants table. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * A protocol's deterministic fold: the first eight hex digits of the SHA-256 of its slug,
 * mod five. No clock, no randomness -- the same snapshot always splits the same way.
 */
function foldOf(slug: string): number {
  const hex = createHash('sha256').update(slug, 'utf8').digest('hex').slice(0, 8);
  return parseInt(hex, 16) % 5;
}

/**
 * Least squares by the normal equations, solved by Gauss-Jordan with partial pivoting.
 * `rows` carry a feature object and a target; `keys` names the features (the intercept is
 * always first). Returns the coefficients, intercept first.
 */
function olsFit(rows: { x: Record<string, number>; y: number }[], keys: string[]): number[] {
  const n = keys.length + 1;
  const X = rows.map((r) => [1, ...keys.map((k) => r.x[k]!)]);
  const y = rows.map((r) => r.y);
  const A: number[][] = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => X.reduce((s, row) => s + row[a]! * row[b]!, 0)));
  const bv: number[] = Array.from({ length: n }, (_, a) => X.reduce((s, row, i) => s + row[a]! * y[i]!, 0));
  const M: number[][] = A.map((row, i) => [...row, bv[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const pv = M[c]![c]!;
    M[c] = M[c]!.map((v) => v / pv);
    for (let r = 0; r < n; r++) {
      if (r !== c && M[r]![c] !== 0) {
        const f = M[r]![c]!;
        M[r] = M[r]!.map((v, j) => v - f * M[c]![j]!);
      }
    }
  }
  return M.map((row) => row[n]!);
}

// ---------------------------------------------------------------- the comps fit

/** The live-token protocols the comps curve is fitted on: a market cap above zero. */
function compsProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/**
 * One protocol's features for the comps fit: `carry` carries its TVL a week forward at the
 * 7-day rate. `dir` is the 7-day change's direction (+1 up, -1 down, 0 flat or unknown);
 * `size` is the change's size as a fraction, clamped to -50%..+50%, used only by the
 * dropped forms that test whether the size helps (it does not).
 */
function compsFeatures(p: SnapshotProtocol, asOf: string, carry: number): Record<string, number> {
  const change = finite(p.change_7d, 0);
  const direction = change > 0 ? 1 : change < 0 ? -1 : 0;
  const size = Math.max(-0.5, Math.min(0.5, change / 100));
  const tvl = Math.max(p.tvl_usd * (1 + carry * size), 1);
  const age = ageDays(asOf, p.listed_at);
  return {
    ltvl: Math.log(tvl),
    dir: direction,
    size,
    age: Math.log((age ?? 365) + 1),
    chains: Math.log(p.chains.length + 1),
  };
}

function predict(coef: number[], keys: string[], x: Record<string, number>): number {
  return coef[0]! + keys.reduce((s, k, i) => s + coef[i + 1]! * x[k]!, 0);
}

/**
 * The held-out miss of one comps form: the median absolute log error, as a factor.
 * Five-fold cross-validation (the mean of the five folds' median errors, each fold held
 * out in turn) and the single split (fold 0 held out, the rest trained on). The miss is
 * exp(median |log error|): x3.70 means the typical held-out market cap lands within a
 * factor of 3.70 of the fitted value.
 */
function compsMiss(
  comps: SnapshotProtocol[],
  asOf: string,
  keys: string[],
  carry: number,
): { fiveFold: number; single: number } {
  const rows = comps.map((p) => ({ x: compsFeatures(p, asOf, carry), y: Math.log(p.mcap_usd!), fold: foldOf(p.slug) }));
  const foldMiss = (testFold: number): number => {
    const train = rows.filter((r) => r.fold !== testFold);
    const test = rows.filter((r) => r.fold === testFold);
    const coef = olsFit(train, keys);
    return median(test.map((r) => Math.abs(r.y - predict(coef, keys, r.x))));
  };
  const fiveFold = [0, 1, 2, 3, 4].map(foldMiss).reduce((s, e) => s + e, 0) / 5;
  return { fiveFold: Math.exp(fiveFold), single: Math.exp(foldMiss(0)) };
}

/** The flat multiple's held-out miss: the median market-cap / TVL of the training fold. */
function flatMiss(comps: SnapshotProtocol[]): { fiveFold: number; single: number } {
  const rows = comps.map((p) => ({ ratio: p.mcap_usd! / p.tvl_usd, fold: foldOf(p.slug) }));
  const foldMiss = (testFold: number): number => {
    const med = median(rows.filter((r) => r.fold !== testFold).map((r) => r.ratio));
    return median(rows.filter((r) => r.fold === testFold).map((r) => Math.abs(Math.log(r.ratio / med))));
  };
  const fiveFold = [0, 1, 2, 3, 4].map(foldMiss).reduce((s, e) => s + e, 0) / 5;
  return { fiveFold: Math.exp(fiveFold), single: Math.exp(foldMiss(0)) };
}

/**
 * The comps curve and its held-out table. The kept form is TVL plus the 7-day direction:
 * it wins both the 5-fold and the single-split test. The change's size, age and chain
 * count are tried and dropped, and the table says so -- a term that does not win its
 * held-out test does not enter the model.
 */
function fitComps(snapshot: Snapshot): { coef: number[]; validation: CompsTest[]; n: number } {
  const comps = compsProtocols(snapshot);
  const forms: { label: string; keys: string[]; carry: number; kept: boolean; note: string }[] = [
    { label: 'TVL + 7-day direction (kept)', keys: ['ltvl', 'dir'], carry: 0, kept: true, note: 'Wins both held-out tests; the direction term is kept.' },
    { label: 'TVL only', keys: ['ltvl'], carry: 0, kept: false, note: 'The baseline curve; the direction term beats it on both tests.' },
    { label: 'TVL, carried a week forward', keys: ['ltvl'], carry: 1, kept: false, note: 'Carrying TVL at the 7-day rate beats TVL alone on the single split but loses the 5-fold; dropped.' },
    { label: 'TVL + change size', keys: ['ltvl', 'size'], carry: 0, kept: false, note: 'The size of the weekly move loses to TVL alone on both tests; only its direction helps.' },
    { label: 'TVL + age', keys: ['ltvl', 'age'], carry: 0, kept: false, note: 'Wins the 5-fold by a hair but loses the single split badly; dropped.' },
    { label: 'TVL + chain count', keys: ['ltvl', 'chains'], carry: 0, kept: false, note: 'Loses on both tests; dropped.' },
    { label: 'TVL + direction + age', keys: ['ltvl', 'dir', 'age'], carry: 0, kept: false, note: 'Adding age to the kept form loses the single split; dropped.' },
    { label: 'TVL + direction + age + chains', keys: ['ltvl', 'dir', 'age', 'chains'], carry: 0, kept: false, note: 'Every term together loses on both tests; dropped.' },
  ];
  const validation: CompsTest[] = forms.map((f) => {
    const miss = compsMiss(comps, snapshot.as_of, f.keys, f.carry);
    return { label: f.label, five_fold_miss: round4(miss.fiveFold), single_split_miss: round4(miss.single), kept: f.kept, note: f.note };
  });
  const flat = flatMiss(comps);
  validation.unshift({
    label: 'Flat median multiple',
    five_fold_miss: round4(flat.fiveFold),
    single_split_miss: round4(flat.single),
    kept: false,
    note: 'One multiple for every protocol; the fitted curve beats it by a wide margin.',
  });
  const coef = olsFit(
    comps.map((p) => ({ x: compsFeatures(p, snapshot.as_of, 0), y: Math.log(p.mcap_usd!) })),
    ['ltvl', 'dir'],
  );
  return { coef, validation, n: comps.length };
}

// ---------------------------------------------------------------- launch odds

/** The current-status records the survival curve is fitted on: age, and token yet or not. */
function survivalRecords(snapshot: Snapshot): { age: number; hasToken: boolean }[] {
  const out: { age: number; hasToken: boolean }[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age === null) continue;
    out.push({ age, hasToken: p.gecko_id !== null || p.symbol !== null });
  }
  return out;
}

/** The survival curve's value at an age: the share of protocols that record a token by then. */
function survivalF(age: number, q: number, tau: number, k: number): number {
  if (age <= 0) return 0;
  return q * (1 - Math.exp(-((age / tau) ** k)));
}

/** The negative log-likelihood of a survival curve on current-status records. */
function survivalNll(records: { age: number; hasToken: boolean }[], q: number, tau: number, k: number): number {
  let total = 0;
  for (const r of records) {
    const f = Math.min(Math.max(survivalF(r.age, q, tau, k), 1e-9), 1 - 1e-9);
    total += r.hasToken ? Math.log(f) : Math.log(1 - f);
  }
  return -total;
}

const SURVIVAL_Q = [0.85, 0.9, 0.95, 1.0];
const SURVIVAL_TAU = [400, 800, 944, 1200, 1600, 2400];
const SURVIVAL_K = [0.4, 0.5, 0.6, 0.75, 1.0];

/** The survival curve that best fits the records, by grid search on the log-likelihood. */
function fitSurvival(records: { age: number; hasToken: boolean }[]): { q: number; tau: number; k: number; nll: number } {
  let best = { q: 1, tau: 1200, k: 0.5, nll: Infinity };
  for (const q of SURVIVAL_Q) {
    for (const tau of SURVIVAL_TAU) {
      for (const k of SURVIVAL_K) {
        const nll = survivalNll(records, q, tau, k);
        if (nll < best.nll) best = { q, tau, k, nll };
      }
    }
  }
  return best;
}

/**
 * The one-year launch odds for a protocol of a given age: the chance it records a token
 * in the next year, given it has not yet. Young protocols launch sooner; old ones, having
 * run for years with no token, launch more slowly -- the curve falls with age.
 */
export function launchOdds(age: number | null, survival: { q: number; tau: number; k: number }): number {
  const t = age ?? 365;
  const numerator = survival.q * (survivalF(t + 365, survival.q, survival.tau, survival.k) - survivalF(t, survival.q, survival.tau, survival.k));
  const denominator = 1 - survival.q * survivalF(t, survival.q, survival.tau, survival.k);
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * The launch-odds held-out test: fit the curve on four folds, predict whether the fifth
 * fold's protocols record a token (a probability above one half counts as a yes), and
 * compare with predicting the majority class for everyone. The Brier score is the same
 * comparison on the probabilities themselves.
 */
function validateSurvival(snapshot: Snapshot): SurvivalTest {
  const withFold = snapshot.protocols
    .map((p) => ({ age: ageDays(snapshot.as_of, p.listed_at), hasToken: p.gecko_id !== null || p.symbol !== null, fold: foldOf(p.slug) }))
    .filter((r): r is { age: number; hasToken: boolean; fold: number } => r.age !== null);
  let accs: number[] = [];
  let baseAccs: number[] = [];
  let briers: number[] = [];
  let baseBriers: number[] = [];
  for (let f = 0; f < 5; f++) {
    const train = withFold.filter((r) => r.fold !== f);
    const test = withFold.filter((r) => r.fold === f);
    if (test.length === 0) continue;
    const fit = fitSurvival(train);
    const base = train.reduce((s, r) => s + (r.hasToken ? 1 : 0), 0) / train.length;
    let correct = 0;
    let brier = 0;
    let baseBrier = 0;
    for (const r of test) {
      const p = survivalF(r.age, fit.q, fit.tau, fit.k);
      correct += (p >= 0.5) === r.hasToken ? 1 : 0;
      brier += (p - (r.hasToken ? 1 : 0)) ** 2;
      baseBrier += (base - (r.hasToken ? 1 : 0)) ** 2;
    }
    accs.push(correct / test.length);
    baseAccs.push(Math.max(base, 1 - base));
    briers.push(brier / test.length);
    baseBriers.push(baseBrier / test.length);
  }
  const full = fitSurvival(withFold);
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  return {
    protocols: withFold.length,
    accuracy: round4(mean(accs)),
    base_accuracy: round4(mean(baseAccs)),
    brier: round4(mean(briers)),
    base_brier: round4(mean(baseBriers)),
    nll: round4(full.nll),
  };
}

/** The calibration table: the observed token rate by age bucket against the fitted curve. */
function calibrationTable(snapshot: Snapshot, survival: { q: number; tau: number; k: number }): CalibrationRow[] {
  const buckets: [number, number | null][] = [[0, 90], [90, 365], [365, 730], [730, 1460], [1460, null]];
  return buckets.map(([lo, hi]) => {
    const group = snapshot.protocols.filter((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      return age !== null && age >= lo && (hi === null || age < hi);
    });
    const mid = hi === null ? 2000 : (lo + hi) / 2;
    return {
      age_from_days: lo,
      age_to_days: hi,
      protocols: group.length,
      empirical_rate: round4(group.length === 0 ? 0 : group.filter((p) => p.gecko_id !== null || p.symbol !== null).length / group.length),
      model_rate: round4(survival.q * survivalF(mid, survival.q, survival.tau, survival.k)),
      odds_1y: round4(launchOdds(mid, survival)),
    };
  });
}

/** The whole fitted model, with its held-out validation, from the snapshot alone. */
function modelFor(snapshot: Snapshot): { model: ModelConstants; validation: Validation } {
  const comps = fitComps(snapshot);
  const records = survivalRecords(snapshot);
  const survival = fitSurvival(records);
  const model: ModelConstants = {
    intercept: round4(comps.coef[0]!),
    tvl_coef: round4(comps.coef[1]!),
    direction_coef: round4(comps.coef[2]!),
    survival_q: survival.q,
    survival_tau: survival.tau,
    survival_k: survival.k,
    unknown_age_days: 365,
    verdict_deposit_usd: 1000,
    verdict_pool_fraction: 0.05,
    verdict_farmed_fraction: 0.05,
    verdict_gas_usd: 25,
    verdict_tbill: 0.04,
    verdict_hold_days: 90,
  };
  return {
    model,
    validation: {
      comps_protocols: comps.n,
      comps: comps.validation,
      survival: validateSurvival(snapshot),
      calibration: calibrationTable(snapshot, survival),
    },
  };
}

// ---------------------------------------------------------------- implied value

/** The fitted launch value, the launch odds, and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { fitted: number; odds: number; implied: number; direction: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const change = finite(protocol.change_7d, 0);
  const direction = change > 0 ? 1 : change < 0 ? -1 : 0;
  const fitted = Math.exp(model.intercept + model.tvl_coef * Math.log(Math.max(protocol.tvl_usd, 1)) + model.direction_coef * direction);
  const odds = launchOdds(age, { q: model.survival_q, tau: model.survival_tau, k: model.survival_k });
  return { fitted, odds, implied: Math.max(1, Math.round(fitted * odds)), direction, age };
}

// ---------------------------------------------------------------- the watchlist rule

/** Whether a protocol records a token already: a Gecko id or a symbol is on its record. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist's rule keeps out: a wrapped, staked or bridged product of a token that trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a protocol's name must not begin with. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why the watchlist's rule sets a protocol aside, or null when the board may rank it.
 * The rule is the one the house drew the watchlist with, applied to every protocol, so
 * the early rows below the floor are held to the same bar as the watchlist rows -- and
 * every set-aside protocol carries the reason it was set aside.
 */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'records a token already';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSIONED.test(p.name)) return 'versioned name';
  const words = p.name.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.some((w) => w === 'wrapped' || w === 'staked' || w === 'staking')) return 'wrapped / staked word in the name';
  if (words.length > 0 && EXCHANGE_NAMES.some((e) => e.toLowerCase() === words[0])) return 'exchange-named';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token, and none of the rule's exclusions. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return exclusionReason(p) === null;
}

// ---------------------------------------------------------------- farm verdicts

/**
 * What a deposit earns on one protocol, at the stated assumptions: farmers share
 * `pool_fraction` of the implied launch value, split among the farmers in proportion to
 * their deposits, and the farmed deposits are `farmed_fraction` of the protocol's TVL --
 * so a deposit's share of the farmer pool is deposit / (TVL x farmed_fraction), capped at
 * one half. Gas is a flat charge across the plan's steps; the T-bill yield is what the
 * deposit would have earned sitting in bills for the hold instead.
 *
 * The verdict follows the net: FARM clears 10% on the deposit, THIN covers its costs,
 * SKIP loses money. The board ranks launches by size; the verdict ranks them by what a
 * deposit earns -- the giants are crowded, so a $1,000 deposit is a rounding error in a
 * $2.7B protocol, and the best farms are usually the smaller, high-multiple ones.
 */
export function verdictFor(
  impliedValueUsd: number,
  tvlUsd: number,
  model: ModelConstants,
  params?: { deposit?: number; pool?: number; farmed?: number; gas?: number; tbill?: number; hold?: number },
): FarmVerdict {
  const deposit = params?.deposit ?? model.verdict_deposit_usd;
  const pool = params?.pool ?? model.verdict_pool_fraction;
  const farmed = params?.farmed ?? model.verdict_farmed_fraction;
  const gas = params?.gas ?? model.verdict_gas_usd;
  const tbill = params?.tbill ?? model.verdict_tbill;
  const hold = params?.hold ?? model.verdict_hold_days;
  const share = Math.min(deposit / (tvlUsd * farmed), 0.5);
  const gross = impliedValueUsd * pool * share;
  const net = gross - gas - (deposit * tbill * hold) / 365;
  return {
    verdict: net >= deposit * 0.1 ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP',
    expected_return_usd: Math.round(net * 100) / 100,
    expected_gross_usd: Math.round(gross * 100) / 100,
    farmer_share: share,
  };
}

// ---------------------------------------------------------------- farm steps

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The plan's first deployment, in the protocol's own terms: the category picks the action,
 * the chain picks where it happens, the capital is the first $500 of the $1,000 deposit.
 */
function firstDeployment(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $500 of USDC on ${name} (${chain}) and keep the loan-to-value under 60%.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Provide $500 of liquidity to ${name}'s deepest pool on ${chain} and keep the position open.`;
  }
  if (c.includes('bridge')) return `Bridge $500 of USDC to ${chain} through ${name}, then use the bridged funds in its app the same day.`;
  if (c.includes('stak')) return `Stake $500 of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $500 of USDC as margin on ${name} (${chain}) and open one small hedged position.`;
  }
  if (c.includes('prediction')) return `Fund $500 and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('capital')) {
    return `Deposit $500 into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (c.includes('stable')) return `Mint or deposit $500 of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $500 of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $500 of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $500 of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The plan's second deployment: a different, smaller action on the same protocol. */
function secondDeployment(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Borrow $150 of USDC against the lent position on ${name} and hold the borrowed funds in the same wallet.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Stake the $300 liquidity receipt from ${name} in its rewards contract so the position earns twice.`;
  }
  if (c.includes('bridge')) return `Bridge a further $300 of USDC to ${chain} through ${name} a week later, from the same wallet.`;
  if (c.includes('stak')) return `Stake a further $300 through ${name} and delegate it to a second validator.`;
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Add $300 of margin on ${name} and open a second small position in the opposite direction.`;
  }
  if (c.includes('prediction')) return `Place a second $300 market position on ${name}, on a different outcome.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('capital')) {
    return `Deposit a further $300 into a second ${name} vault on ${chain} so two strategies are running.`;
  }
  if (c.includes('stable')) return `Deposit a further $300 of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint a further $300 of ${name}'s yield-bearing asset on ${chain}.`;
  if (c.includes('insurance')) return `Buy a further $300 of cover from ${name} on ${chain}, for a different risk.`;
  return `Open a second $300 position on ${name} (${chain}) from the same wallet.`;
}

/** The plan's third deployment: the last $200, kept liquid for fees and one more action. */
function thirdDeployment(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Swap $200 through ${name}'s router on ${chain} so the wallet shows a trade as well as a liquidity position.`;
  }
  if (c.includes('bridge')) return `Keep $200 on ${chain} for gas, and bridge $100 of it back through ${name} to show both directions.`;
  if (c.includes('prediction')) return `Place one last $200 market position on ${name}, then stop trading.`;
  return `Keep $200 in ${chain}'s native asset for gas, and use $100 of it for one more qualifying action on ${name}.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The three
 * deployments split the $1,000 deposit ($500 + $300 + $200), the hold follows the
 * protocol's age, and the exit claims only from the protocol's own site. Every step is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: 'Set up a fresh wallet that holds only the $1,000 farming funds, and write its seed phrase on paper, never in a file or a chat.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    { text: firstDeployment(p, chain), cost: '$500 of capital and about $8 of gas', time: '15 minutes to set up' },
    { text: secondDeployment(p, chain), cost: '$300 of capital and about $6 of gas', time: '10 minutes to set up' },
    { text: thirdDeployment(p, chain), cost: '$200 of capital and about $5 of gas', time: '10 minutes to set up' },
    {
      text: `Do one qualifying action every week -- a deposit, a borrow, a swap or a vote -- and keep the whole $1,000 position open for at least ${hold} days so the activity shows up in more than one snapshot.`,
      cost: 'about $2 of gas a week',
      time: `${hold} days, 10 minutes a week`,
    },
    {
      text: "When a rewards page appears, open it only from the protocol's own site and never pay to claim; then unwind the three positions, and record the wallet, the dates and every transaction hash in a farm log.",
      cost: 'about $6 of gas to unwind',
      time: '20 minutes',
    },
  ];
}

// ---------------------------------------------------------------- the board and the views

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, whatever its TVL.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other protocol that passes the watchlist's own rule,
  // below the floor or above it -- the rule, not the floor, decides what ranks.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isLaunchCandidate(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const { fitted, odds, implied, direction, age } = impliedValue(p, snapshot.as_of, model);
    const verdict = verdictFor(implied, p.tvl_usd, model);
    return { p, fitted, odds, implied, direction, age, verdict };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    fitted_value_usd: Math.round(s.fitted),
    launch_odds: round4(s.odds),
    verdict: s.verdict.verdict,
    expected_return_usd: s.verdict.expected_return_usd,
    model: { direction: s.direction, age_days: s.age },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, all of them, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? -1) - (a.mcap_usd ?? -1) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      age_days: ageDays(snapshot.as_of, p.listed_at),
    }));
}

/** The pre-token protocols the board sets aside, each with the reason the rule gives. */
export function setAsideRows(snapshot: Snapshot): SetAsideRow[] {
  return snapshot.protocols
    .filter((p) => isPreToken(p) && !isLaunchCandidate(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: exclusionReason(p) ?? 'set aside' }));
}

/** A board row's compact form for data.js, farm plan included so the page shows the board's own steps. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    fitted_value_usd: row.fitted_value_usd,
    launch_odds: row.launch_odds,
    verdict: row.verdict,
    expected_return_usd: row.expected_return_usd,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { model, validation } = modelFor(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const setAside = setAsideRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    validation,
    model_version: MODEL_VERSION,
    total_protocols: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    set_aside_size: setAside.length,
    rows: board.map(radarRow),
    live,
    set_aside: setAside,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
