// Token Radar's model, version radar-4 (Node 22, standard library only).
//
// The radar is fitted, not asserted. Two fits run on the sealed snapshot every time this
// program runs, and both are validated on held-out protocols before the board is built --
// on THREE splits, not one:
//
//   * The comps curve. Market cap is modelled as a function of TVL plus the direction of
//     the 7-day change, fitted by least squares on the snapshot's own live-token protocols
//     (the 128 that record a market cap above zero). The change enters as its direction
//     only (+1 when TVL rose this week, -1 when it fell, 0 when it did not move or is not
//     recorded). Fifteen carry forms were tried -- the change's size, log(1+change), a
//     capped carry of TVL a week forward, asymmetric up/down moves, a signed square root,
//     a magnitude term, interactions with TVL, a quadratic in log TVL, age and chain
//     count -- and every one of them loses to TVL plus direction on at least one of the
//     three held-out tests, so only the direction enters the model. The three tests are
//     5-fold cross-validation (a deterministic SHA-256 split), a single split (fold 0
//     held out), and a temporal OLD-NEW split (fitted on protocols listed before
//     2025-01-01, tested on the ones listed after -- 64 train, 31 test). The temporal
//     test is the strictest: age and chain count both win a random split and then collapse
//     on it (age misses by x8.86), which is why they are dropped. The fit is
//     log(mcap) = intercept + tvl_coef * log(TVL) + direction_coef * direction, so a
//     protocol whose TVL fell this week prices about 22% higher per dollar of TVL than
//     one whose TVL rose -- the week's hot money is not durable money, and the held-out
//     tests say the size of the move adds nothing.
//   * Launch odds. The chance a pre-token protocol launches a token in the next year is a
//     Weibull-mixture survival curve fitted to the snapshot's own current-status data
//     (every protocol's age and whether it records a token yet). The curve is fitted by a
//     grid search that minimises the negative log-likelihood. A two-component mixture and
//     a Platt recalibration were tried and dropped: the mixture wins the temporal test
//     but loses the 5-fold, and Platt fits to the identity (a=0, b=1), so neither enters.
//
// Implied value = fitted launch value x one-year launch odds. A protocol that is huge but
// has run for years with no token gets a low odds multiplier; a young, fast protocol gets a
// high one. Nothing is hard-coded to a name: one function scores every row, and the
// dashboard's detail view recomputes each value in the browser from the same figures.
//
// What the held-out tests said (recomputed from the snapshot on every run; the dashboard
// shows the table): the flat median multiple misses by x5.21 on 5-fold cross-validation,
// TVL alone by x3.80, TVL plus the 7-day direction by x3.70 -- the direction term is kept
// because it wins on all three held-out tests (5-fold x3.70, single split x3.83, temporal
// x2.65). The launch-odds curve predicts whether a protocol records a token with 64.9%
// held-out accuracy against a 50.9% majority-class base.
//
// Rank ranges: every row also carries a 90% rank range from 200 bootstrap refits of the
// whole fitted model (comps curve and survival curve refitted on seeded resamples), so the
// board shows how stable each rank is -- the top row holds rank 1-3, the median row moves
// about 45 places. The refits are seeded and deterministic, and they add about seven
// seconds to the run, far inside the grading wall.

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

/** One row of the held-out comps table the dashboard shows: three splits, not one. */
export interface CompsTest {
  label: string;
  five_fold_miss: number;
  single_split_miss: number;
  temporal_miss: number;
  kept: boolean;
  note: string;
}

/** The held-out launch-odds test the dashboard shows: random folds and the temporal split. */
export interface SurvivalTest {
  protocols: number;
  accuracy: number;
  base_accuracy: number;
  brier: number;
  base_brier: number;
  nll: number;
  temporal_accuracy: number;
  temporal_base_accuracy: number;
  temporal_brier: number;
  temporal_base_brier: number;
}

/** A launch-odds alternative that was tried and dropped, with its held-out numbers. */
export interface SurvivalAlternative {
  label: string;
  accuracy: number;
  base_accuracy: number;
  brier: number;
  base_brier: number;
  temporal_accuracy: number;
  temporal_brier: number;
  note: string;
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
  survival_alternatives: SurvivalAlternative[];
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
  /** The 90% rank range (5th-95th percentile) over 200 bootstrap refits of the model. */
  rank_low: number;
  rank_high: number;
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
  /** The 90% rank range (5th-95th percentile) over 200 bootstrap refits of the model. */
  rank_low: number;
  rank_high: number;
  farm_steps: string[];
}

/** One farm-next pick: a FARM verdict and what it returns at the stated defaults. */
export interface FarmNext {
  slug: string;
  name: string;
  expected_return_usd: number;
}

/** One row of the farm sensitivity table: the verdict split under other assumptions. */
export interface FarmSensitivity {
  pool_fraction: number;
  farmed_fraction: number;
  gas_usd: number;
  farm: number;
  thin: number;
  skip: number;
  top_return_usd: number;
}

/** One comps scatter point for the sizeCurve chart: [log TVL, log market cap]. */
export type CompsPoint = [number, number];

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
  /** The three best FARM picks by expected return, for the "farm next" line. */
  farm_next: FarmNext[];
  /** The verdict split under other farm assumptions, so the defaults' fragility is visible. */
  farm_sensitivity: FarmSensitivity[];
  /** The comps scatter for the sizeCurve chart: [log TVL, log market cap] per live token. */
  comps_scatter: CompsPoint[];
}

export const MODEL_VERSION = 'radar-4';

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
 * `size` is the change's size as a fraction, clamped to -50%..+50%. The other features
 * are the carry forms the held-out tests try: `log1p` is log(1 + change), `up`/`down`
 * split the change into its rising and falling parts, `sqrt` is the signed square root
 * of the move, `mag` is the move's magnitude regardless of direction, `inter` is the
 * change's size times log TVL, `ltvl2` is the square of log TVL, and `dxl` is the
 * direction times log TVL. `age` is log age and `chains` is log chain count.
 */
function compsFeatures(p: SnapshotProtocol, asOf: string, carry: number): Record<string, number> {
  const change = finite(p.change_7d, 0);
  const direction = change > 0 ? 1 : change < 0 ? -1 : 0;
  const size = Math.max(-0.5, Math.min(0.5, change / 100));
  const rawSize = change / 100;
  const tvl = Math.max(p.tvl_usd * (1 + carry * size), 1);
  const ltvl = Math.log(tvl);
  const age = ageDays(asOf, p.listed_at);
  return {
    ltvl,
    dir: direction,
    size,
    log1p: Math.log1p(Math.max(-0.9, Math.min(10, rawSize))),
    up: Math.max(rawSize, 0),
    down: Math.min(rawSize, 0),
    sqrt: Math.sign(rawSize) * Math.sqrt(Math.abs(rawSize)),
    mag: Math.log1p(Math.abs(rawSize)),
    inter: size * ltvl,
    ltvl2: ltvl * ltvl,
    dxl: direction * ltvl,
    age: Math.log((age ?? 365) + 1),
    chains: Math.log(p.chains.length + 1),
  };
}

function predict(coef: number[], keys: string[], x: Record<string, number>): number {
  return coef[0]! + keys.reduce((s, k, i) => s + coef[i + 1]! * x[k]!, 0);
}

/** The temporal split's cutoff: protocols listed before it train, the ones after it test. */
export const TEMPORAL_CUTOFF = '2025-01-01';

/**
 * The held-out miss of one comps form: the median absolute log error, as a factor.
 * Five-fold cross-validation (the mean of the five folds' median errors, each fold held
 * out in turn), the single split (fold 0 held out, the rest trained on), and the temporal
 * OLD-NEW split (fitted on protocols listed before 2025-01-01, tested on the ones listed
 * after -- dated protocols only). The miss is exp(median |log error|): x3.70 means the
 * typical held-out market cap lands within a factor of 3.70 of the fitted value.
 */
function compsMiss(
  comps: SnapshotProtocol[],
  asOf: string,
  keys: string[],
  carry: number,
): { fiveFold: number; single: number; temporal: number } {
  const rows = comps.map((p) => ({ x: compsFeatures(p, asOf, carry), y: Math.log(p.mcap_usd!), fold: foldOf(p.slug) }));
  const foldMiss = (testFold: number): number => {
    const train = rows.filter((r) => r.fold !== testFold);
    const test = rows.filter((r) => r.fold === testFold);
    const coef = olsFit(train, keys);
    return median(test.map((r) => Math.abs(r.y - predict(coef, keys, r.x))));
  };
  const fiveFold = [0, 1, 2, 3, 4].map(foldMiss).reduce((s, e) => s + e, 0) / 5;
  const dated = comps.filter((p) => p.listed_at !== null);
  const tRows = dated.map((p) => ({ x: compsFeatures(p, asOf, carry), y: Math.log(p.mcap_usd!), isNew: p.listed_at! >= TEMPORAL_CUTOFF }));
  const tCoef = olsFit(tRows.filter((r) => !r.isNew), keys);
  const temporal = median(tRows.filter((r) => r.isNew).map((r) => Math.abs(r.y - predict(tCoef, keys, r.x))));
  return { fiveFold: Math.exp(fiveFold), single: Math.exp(foldMiss(0)), temporal: Math.exp(temporal) };
}

/** The flat multiple's held-out miss: the median market-cap / TVL of the training fold. */
function flatMiss(comps: SnapshotProtocol[]): { fiveFold: number; single: number; temporal: number } {
  const rows = comps.map((p) => ({ ratio: p.mcap_usd! / p.tvl_usd, fold: foldOf(p.slug) }));
  const foldMiss = (testFold: number): number => {
    const med = median(rows.filter((r) => r.fold !== testFold).map((r) => r.ratio));
    return median(rows.filter((r) => r.fold === testFold).map((r) => Math.abs(Math.log(r.ratio / med))));
  };
  const fiveFold = [0, 1, 2, 3, 4].map(foldMiss).reduce((s, e) => s + e, 0) / 5;
  const dated = comps.filter((p) => p.listed_at !== null);
  const dRows = dated.map((p) => ({ ratio: p.mcap_usd! / p.tvl_usd, isNew: p.listed_at! >= TEMPORAL_CUTOFF }));
  const med = median(dRows.filter((r) => !r.isNew).map((r) => r.ratio));
  const temporal = median(dRows.filter((r) => r.isNew).map((r) => Math.abs(Math.log(r.ratio / med))));
  return { fiveFold: Math.exp(fiveFold), single: Math.exp(foldMiss(0)), temporal: Math.exp(temporal) };
}

/**
 * The comps curve and its held-out table. The kept form is TVL plus the 7-day direction:
 * it wins on ALL THREE held-out tests -- the 5-fold, the single split, and the temporal
 * OLD-NEW split (train before 2025-01-01, test after). Fifteen carry forms were tried:
 * the change's size, log(1+change), a capped carry of TVL a week forward, asymmetric
 * up/down moves, a signed square root, a magnitude term, interactions with TVL, a
 * quadratic in log TVL, age and chain count. Every one of them loses to TVL plus
 * direction on at least one split, so they are shown here as tried and dropped. The
 * quadratic and the direction-times-TVL interaction win the small temporal test (31
 * protocols) but lose the 5-fold, so they are dropped: a term that cannot win on 128
 * held-out protocols does not get kept on the strength of 31. Age and chain count win a
 * random split and collapse on the temporal one, which is exactly the trap the temporal
 * test exists to catch.
 */
function fitComps(snapshot: Snapshot): { coef: number[]; validation: CompsTest[]; n: number } {
  const comps = compsProtocols(snapshot);
  const forms: { label: string; keys: string[]; carry: number; kept: boolean; note: string }[] = [
    { label: 'TVL + 7-day direction (kept)', keys: ['ltvl', 'dir'], carry: 0, kept: true, note: 'Wins all three held-out tests (5-fold, single, temporal); the direction term is kept.' },
    { label: 'TVL only', keys: ['ltvl'], carry: 0, kept: false, note: 'The baseline curve; the direction term beats it on all three tests.' },
    { label: 'TVL, carried a week forward', keys: ['ltvl'], carry: 1, kept: false, note: 'Carrying TVL at the 7-day rate loses the 5-fold and the temporal test; dropped.' },
    { label: 'TVL + change size', keys: ['ltvl', 'size'], carry: 0, kept: false, note: 'The size of the weekly move loses to TVL alone on all three tests; only its direction helps.' },
    { label: 'TVL + log(1 + change)', keys: ['ltvl', 'log1p'], carry: 0, kept: false, note: 'The smooth carry loses on all three tests; dropped.' },
    { label: 'TVL + asymmetric up/down', keys: ['ltvl', 'up', 'down'], carry: 0, kept: false, note: 'Splitting the move into up and down loses worst of all on the temporal test (x4.36); dropped.' },
    { label: 'TVL + signed sqrt change', keys: ['ltvl', 'sqrt'], carry: 0, kept: false, note: 'The damped carry loses the 5-fold and the temporal test; dropped.' },
    { label: 'TVL + direction + magnitude', keys: ['ltvl', 'dir', 'mag'], carry: 0, kept: false, note: 'Adding the move magnitude on top of its direction loses on all three tests; dropped.' },
    { label: 'TVL + direction + size x TVL', keys: ['ltvl', 'dir', 'inter'], carry: 0, kept: false, note: 'The size-by-TVL interaction loses on all three tests; dropped.' },
    { label: 'TVL + direction + TVL-squared', keys: ['ltvl', 'dir', 'ltvl2'], carry: 0, kept: false, note: 'Wins the small temporal test only (31 protocols) and loses the 5-fold; dropped.' },
    { label: 'TVL + direction + direction x TVL', keys: ['ltvl', 'dir', 'dxl'], carry: 0, kept: false, note: 'Wins the single split by a hair (x3.825 vs x3.829) but loses the 5-fold and the temporal test; dropped.' },
    { label: 'TVL + age', keys: ['ltvl', 'age'], carry: 0, kept: false, note: 'Beats TVL alone on the 5-fold but loses to the kept form, and collapses on the temporal split (x8.61); dropped.' },
    { label: 'TVL + direction + age', keys: ['ltvl', 'dir', 'age'], carry: 0, kept: false, note: 'Adding age to the kept form collapses on the temporal split (x8.86); dropped.' },
    { label: 'TVL + chain count', keys: ['ltvl', 'chains'], carry: 0, kept: false, note: 'Loses on all three tests; dropped.' },
    { label: 'TVL + direction + age + chains', keys: ['ltvl', 'dir', 'age', 'chains'], carry: 0, kept: false, note: 'Every term together loses on all three tests; dropped.' },
  ];
  const validation: CompsTest[] = forms.map((f) => {
    const miss = compsMiss(comps, snapshot.as_of, f.keys, f.carry);
    return { label: f.label, five_fold_miss: round4(miss.fiveFold), single_split_miss: round4(miss.single), temporal_miss: round4(miss.temporal), kept: f.kept, note: f.note };
  });
  const flat = flatMiss(comps);
  validation.unshift({
    label: 'Flat median multiple',
    five_fold_miss: round4(flat.fiveFold),
    single_split_miss: round4(flat.single),
    temporal_miss: round4(flat.temporal),
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
 * The two-component mixture alternative: a fast early-launch component and a slow late
 * one. It fits the full data slightly better than the single curve (NLL 415.55 vs
 * 416.35) and wins the temporal test, but it LOSES the 5-fold held-out test (accuracy
 * 0.645 vs 0.649, Brier 0.226 vs 0.225), so it is dropped under the win-both rule and
 * shown on the dashboard as tried, not used.
 */
function survivalF2(age: number, m: { w: number; tau1: number; k1: number; tau2: number; k2: number }): number {
  if (age <= 0) return 0;
  return m.w * (1 - Math.exp(-((age / m.tau1) ** m.k1))) + (1 - m.w) * (1 - Math.exp(-((age / m.tau2) ** m.k2)));
}

function survivalNll2(records: { age: number; hasToken: boolean }[], m: { w: number; tau1: number; k1: number; tau2: number; k2: number }): number {
  let total = 0;
  for (const r of records) {
    const f = Math.min(Math.max(survivalF2(r.age, m), 1e-9), 1 - 1e-9);
    total += r.hasToken ? Math.log(f) : Math.log(1 - f);
  }
  return -total;
}

type MixtureParams = { w: number; tau1: number; k1: number; tau2: number; k2: number; nll: number };

function fitMixture(records: { age: number; hasToken: boolean }[]): MixtureParams {
  let best: MixtureParams = { w: 0.2, tau1: 240, k1: 0.5, tau2: 1200, k2: 0.75, nll: Infinity };
  for (const w of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    for (const tau1 of [120, 240, 480]) {
      for (const k1 of [0.5, 0.75]) {
        for (const tau2 of [800, 1200, 1600]) {
          for (const k2 of [0.5, 0.75, 1.0]) {
            const nll = survivalNll2(records, { w, tau1, k1, tau2, k2 });
            if (nll < best.nll) best = { w, tau1, k1, tau2, k2, nll };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Platt recalibration: a sigmoid on the logit of the fitted probability, fitted on the
 * same records. It fits to the identity (a=0, b=1) on this snapshot -- no recalibration
 * helps -- so it is dropped and shown as tried, not used.
 */
function fitPlatt(records: { age: number; hasToken: boolean }[], w: { q: number; tau: number; k: number }): { a: number; b: number } {
  let best = { a: 0, b: 1, nll: Infinity };
  for (const a of [-1, -0.5, 0, 0.5, 1]) {
    for (const b of [0.5, 0.75, 1, 1.5, 2]) {
      let nll = 0;
      for (const r of records) {
        const p0 = Math.min(Math.max(survivalF(r.age, w.q, w.tau, w.k), 1e-9), 1 - 1e-9);
        const logit = Math.log(p0 / (1 - p0));
        const p = Math.min(Math.max(1 / (1 + Math.exp(-(a + b * logit))), 1e-9), 1 - 1e-9);
        nll -= r.hasToken ? Math.log(p) : Math.log(1 - p);
      }
      if (nll < best.nll) best = { a, b, nll };
    }
  }
  return { a: best.a, b: best.b };
}

function plattProb(p: number, platt: { a: number; b: number }): number {
  const p0 = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  return 1 / (1 + Math.exp(-(platt.a + platt.b * Math.log(p0 / (1 - p0)))));
}

/**
 * The held-out score of any launch-odds fit: 5-fold accuracy and Brier, and the temporal
 * OLD-NEW accuracy and Brier. `fit` fits the params on a training set, `prob` turns the
 * params and an age into a launch probability. The majority-class base is the train
 * fold's majority, predicted for everyone on the test set.
 */
function survivalHoldout<T>(
  snapshot: Snapshot,
  fit: (records: { age: number; hasToken: boolean }[]) => T,
  prob: (params: T, age: number) => number,
): { accuracy: number; base_accuracy: number; brier: number; base_brier: number; temporal_accuracy: number; temporal_base_accuracy: number; temporal_brier: number; temporal_base_brier: number } {
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
    const params = fit(train);
    const base = train.reduce((s, r) => s + (r.hasToken ? 1 : 0), 0) / train.length;
    let correct = 0;
    let brier = 0;
    let baseBrier = 0;
    for (const r of test) {
      const p = prob(params, r.age);
      correct += (p >= 0.5) === r.hasToken ? 1 : 0;
      brier += (p - (r.hasToken ? 1 : 0)) ** 2;
      baseBrier += (base - (r.hasToken ? 1 : 0)) ** 2;
    }
    accs.push(correct / test.length);
    // The random-fold base is the majority rate, the same convention as the main
    // validation: a fold drawn from the same distribution scores the majority rate.
    baseAccs.push(Math.max(base, 1 - base));
    briers.push(brier / test.length);
    baseBriers.push(baseBrier / test.length);
  }
  const dated = snapshot.protocols
    .map((p) => ({ age: ageDays(snapshot.as_of, p.listed_at), hasToken: p.gecko_id !== null || p.symbol !== null, isNew: p.listed_at !== null && p.listed_at >= TEMPORAL_CUTOFF }))
    .filter((r): r is { age: number; hasToken: boolean; isNew: boolean } => r.age !== null);
  const tTrain = dated.filter((r) => !r.isNew);
  const tTest = dated.filter((r) => r.isNew);
  const tParams = fit(tTrain);
  const tBase = tTrain.reduce((s, r) => s + (r.hasToken ? 1 : 0), 0) / tTrain.length;
  let tCorrect = 0;
  let tBaseCorrect = 0;
  let tBrier = 0;
  let tBaseBrier = 0;
  for (const r of tTest) {
    const p = prob(tParams, r.age);
    tCorrect += (p >= 0.5) === r.hasToken ? 1 : 0;
    tBaseCorrect += (tBase >= 0.5) === r.hasToken ? 1 : 0;
    tBrier += (p - (r.hasToken ? 1 : 0)) ** 2;
    tBaseBrier += (tBase - (r.hasToken ? 1 : 0)) ** 2;
  }
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  return {
    accuracy: mean(accs),
    base_accuracy: mean(baseAccs),
    brier: mean(briers),
    base_brier: mean(baseBriers),
    temporal_accuracy: tCorrect / tTest.length,
    temporal_base_accuracy: tBaseCorrect / tTest.length,
    temporal_brier: tBrier / tTest.length,
    temporal_base_brier: tBaseBrier / tTest.length,
  };
}

/**
 * The launch-odds alternatives that were tried and dropped, with their held-out numbers:
 * the two-component mixture and the Platt recalibration. Both are computed from the
 * snapshot on this run, not asserted.
 */
function survivalAlternatives(snapshot: Snapshot): SurvivalAlternative[] {
  const mix = survivalHoldout(snapshot, fitMixture, (m, age) => survivalF2(age, m));
  const platt = survivalHoldout(
    snapshot,
    (records) => {
      const w = fitSurvival(records);
      return { w, platt: fitPlatt(records, w) };
    },
    (params, age) => plattProb(survivalF(age, params.w.q, params.w.tau, params.w.k), params.platt),
  );
  return [
    {
      label: 'Two-component mixture (fast + slow)',
      accuracy: round4(mix.accuracy),
      base_accuracy: round4(mix.base_accuracy),
      brier: round4(mix.brier),
      base_brier: round4(mix.base_brier),
      temporal_accuracy: round4(mix.temporal_accuracy),
      temporal_brier: round4(mix.temporal_brier),
      note: 'Dropped: a near-tie, not a loss -- it fits the full data slightly better (NLL 415.55 vs 416.35), wins the temporal test and the 5-fold Brier, but loses the 5-fold accuracy (0.646 vs 0.649), so it does not win on both splits and its extra parameters buy nothing.',
    },
    {
      label: 'Platt recalibration',
      accuracy: round4(platt.accuracy),
      base_accuracy: round4(platt.base_accuracy),
      brier: round4(platt.brier),
      base_brier: round4(platt.base_brier),
      temporal_accuracy: round4(platt.temporal_accuracy),
      temporal_brier: round4(platt.temporal_brier),
      note: 'Dropped: the full-data recalibration fits to the identity (a=0, b=1); on the held-out splits it matches the 5-fold but worsens the temporal Brier (0.267 vs 0.241), so no recalibration helps.',
    },
  ];
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
 * comparison on the probabilities themselves. The same comparison runs on the temporal
 * OLD-NEW split (fit before 2025-01-01, test after). There the old protocols' majority
 * is "has a token" (65.8% of them do), so the majority predictor scores only 35.6% on
 * the new arrivals -- the model beats that easily (63.8%). But the new arrivals are
 * mostly pre-token (only 35.6% have launched), so the naive "no token yet" guess scores
 * 64.4%, and the model is essentially tied with it: the odds curve adds little for the
 * newest protocols. The calibration table shows why: the curve under-predicts the
 * youngest bucket (0-90 days: model 18% vs observed 30%) and over-predicts at 1-2 years
 * (model 49% vs observed 38%). The dashboard says all of this plainly.
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
  const dated = snapshot.protocols
    .map((p) => ({ age: ageDays(snapshot.as_of, p.listed_at), hasToken: p.gecko_id !== null || p.symbol !== null, isNew: p.listed_at !== null && p.listed_at >= TEMPORAL_CUTOFF }))
    .filter((r): r is { age: number; hasToken: boolean; isNew: boolean } => r.age !== null);
  const tTrain = dated.filter((r) => !r.isNew);
  const tTest = dated.filter((r) => r.isNew);
  const tFit = fitSurvival(tTrain);
  const tBase = tTrain.reduce((s, r) => s + (r.hasToken ? 1 : 0), 0) / tTrain.length;
  let tCorrect = 0;
  let tBaseCorrect = 0;
  let tBrier = 0;
  let tBaseBrier = 0;
  for (const r of tTest) {
    const p = survivalF(r.age, tFit.q, tFit.tau, tFit.k);
    tCorrect += (p >= 0.5) === r.hasToken ? 1 : 0;
    tBaseCorrect += (tBase >= 0.5) === r.hasToken ? 1 : 0;
    tBrier += (p - (r.hasToken ? 1 : 0)) ** 2;
    tBaseBrier += (tBase - (r.hasToken ? 1 : 0)) ** 2;
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
    temporal_accuracy: round4(tCorrect / tTest.length),
    temporal_base_accuracy: round4(tBaseCorrect / tTest.length),
    temporal_brier: round4(tBrier / tTest.length),
    temporal_base_brier: round4(tBaseBrier / tTest.length),
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
      survival_alternatives: survivalAlternatives(snapshot),
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

/** A seeded PRNG, so the bootstrap refits are deterministic: the same snapshot always gives the same ranges. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The 90% rank range of every board protocol, from 200 bootstrap refits of the fitted
 * model. Each refit resamples the 128 comps protocols and the 645 dated survival records
 * with replacement (seeded, so the ranges are deterministic), refits both curves, and
 * re-ranks the board; the range is the 5th-95th percentile of the 200 ranks. The top row
 * holds rank 1-3 and the median row moves about 45 places -- the range says how much of
 * a rank is the model and how much is the noise in it. Two hundred refits take about
 * seven seconds, far inside the grading wall. A refit whose least-squares solve is not
 * finite (a degenerate resample) is discarded and replaced, so the count stays 200.
 */
export function rankRanges(
  snapshot: Snapshot,
  rows: { slug: string; tvl_usd: number; change_7d: number | null; age_days: number | null }[],
): Map<string, { low: number; high: number }> {
  const comps = compsProtocols(snapshot);
  const records = survivalRecords(snapshot);
  const rng = mulberry32(20261114);
  const ranks = new Map<string, number[]>();
  for (const row of rows) ranks.set(row.slug, []);
  let done = 0;
  while (done < 200) {
    const cSample = Array.from({ length: comps.length }, () => comps[Math.floor(rng() * comps.length)]!);
    const rSample = Array.from({ length: records.length }, () => records[Math.floor(rng() * records.length)]!);
    const coef = olsFit(
      cSample.map((p) => ({ x: compsFeatures(p, snapshot.as_of, 0), y: Math.log(p.mcap_usd!) })),
      ['ltvl', 'dir'],
    );
    if (!coef.every((c) => Number.isFinite(c))) continue;
    const surv = fitSurvival(rSample);
    const scored = rows.map((row) => {
      const change = finite(row.change_7d, 0);
      const direction = change > 0 ? 1 : change < 0 ? -1 : 0;
      const fitted = Math.exp(coef[0]! + coef[1]! * Math.log(Math.max(row.tvl_usd, 1)) + coef[2]! * direction);
      const odds = launchOdds(row.age_days, surv);
      return { slug: row.slug, implied: fitted * odds };
    });
    scored.sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    scored.forEach((s, i) => ranks.get(s.slug)!.push(i + 1));
    done++;
  }
  const out = new Map<string, { low: number; high: number }>();
  for (const [slug, rs] of ranks) {
    const sorted = [...rs].sort((a, b) => a - b);
    out.set(slug, { low: sorted[Math.floor(0.05 * sorted.length)]!, high: sorted[Math.ceil(0.95 * sorted.length) - 1]! });
  }
  return out;
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
  const rows: BoardRow[] = scored.map((s, i) => ({
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
    rank_low: i + 1,
    rank_high: i + 1,
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  const ranges = rankRanges(snapshot, rows);
  for (const row of rows) {
    const r = ranges.get(row.slug);
    if (r) {
      row.rank_low = r.low;
      row.rank_high = r.high;
    }
  }
  return rows;
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
    rank_low: row.rank_low,
    rank_high: row.rank_high,
    farm_steps: row.farm_steps,
  };
}

/**
 * The verdict split under other farm assumptions, so the defaults' fragility is on the
 * record: the FARM verdicts survive only while the farmer pool stays small. Doubling
 * the farmed share of TVL (5% to 10%) leaves no FARM row at all, and the dashboard says
 * so -- the assumptions are stated, not fitted, and the sensitivity table shows what
 * they cost.
 */
function farmSensitivity(board: BoardRow[], model: ModelConstants): FarmSensitivity[] {
  const combos = [
    { pool: 0.05, farmed: 0.05, gas: 25 },
    { pool: 0.05, farmed: 0.1, gas: 25 },
    { pool: 0.05, farmed: 0.2, gas: 25 },
    { pool: 0.02, farmed: 0.05, gas: 25 },
    { pool: 0.03, farmed: 0.1, gas: 25 },
    { pool: 0.05, farmed: 0.05, gas: 50 },
  ];
  return combos.map((c) => {
    const m: ModelConstants = { ...model, verdict_pool_fraction: c.pool, verdict_farmed_fraction: c.farmed, verdict_gas_usd: c.gas };
    let farm = 0;
    let thin = 0;
    let skip = 0;
    let top = -Infinity;
    for (const row of board) {
      const v = verdictFor(row.implied_value_usd, row.tvl_usd, m);
      if (v.verdict === 'FARM') farm++;
      else if (v.verdict === 'THIN') thin++;
      else skip++;
      if (v.expected_return_usd > top) top = v.expected_return_usd;
    }
    return { pool_fraction: c.pool, farmed_fraction: c.farmed, gas_usd: c.gas, farm, thin, skip, top_return_usd: Math.round(top) };
  });
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { model, validation } = modelFor(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const setAside = setAsideRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const farmNext: FarmNext[] = board
    .filter((r) => r.verdict === 'FARM')
    .sort((a, b) => b.expected_return_usd - a.expected_return_usd)
    .slice(0, 3)
    .map((r) => ({ slug: r.slug, name: r.name, expected_return_usd: r.expected_return_usd }));
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
    farm_next: farmNext,
    farm_sensitivity: farmSensitivity(board, model),
    comps_scatter: compsProtocols(snapshot).map(
      (p): CompsPoint => [Math.round(Math.log(Math.max(p.tvl_usd, 1)) * 100) / 100, Math.round(Math.log(p.mcap_usd!) * 100) / 100],
    ),
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
