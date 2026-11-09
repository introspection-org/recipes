/**
 * Tree-structured Parzen Estimator (TPE): a small Bayesian optimizer for
 * black-box searches such as hyperparameters or a Recipe's settings, the
 * algorithm Hyperopt and Optuna use by default (Bergstra et al., 2011).
 *
 * Each parameter is modelled on its own. After the random startup trials,
 * the trials told so far are split into the best `gamma(n)` and the rest; a
 * Parzen estimator is fitted to each group, `l(x)` to the good and `g(x)` to
 * the bad, and the candidate drawn from `l` with the highest `l(x) / g(x)` is
 * asked next. Numbers use a mixture of truncated Gaussians, on a log scale
 * when `log` is set; choices use smoothed, weighted counts.
 *
 * ```ts
 * const sampler = new TpeSampler({
 *   lr: float(1e-5, 1e-1, { log: true }),
 *   layers: int(1, 8),
 *   optimizer: choice(["adam", "sgd"]),
 * });
 * for (let i = 0; i < 50; i++) {
 *   const config = sampler.ask();
 *   sampler.tell(config, await evaluate(config));
 * }
 * sampler.best; // { config, value }
 * ```
 */

export interface FloatParam {
  readonly type: "float";
  readonly low: number;
  readonly high: number;
  readonly log: boolean;
}

export interface IntParam {
  readonly type: "int";
  readonly low: number;
  readonly high: number;
  readonly log: boolean;
}

export interface ChoiceParam<T> {
  readonly type: "choice";
  readonly choices: readonly T[];
}

export type Param = FloatParam | IntParam | ChoiceParam<unknown>;
export type SearchSpace = Readonly<Record<string, Param>>;

/** The value each parameter of a space takes in one configuration. */
export type Config<S extends SearchSpace> = {
  -readonly [K in keyof S]: S[K] extends ChoiceParam<infer T> ? T : number;
};

export interface Trial<S extends SearchSpace> {
  config: Config<S>;
  value: number;
}

export interface TpeOptions {
  /** Default `minimize`. */
  direction?: "minimize" | "maximize";
  /** Random trials before TPE takes over. Default 10. */
  startupTrials?: number;
  /** Candidates drawn from `l(x)` per parameter per ask. Default 24. */
  candidates?: number;
  /** How many of `n` trials count as good. Default `min(ceil(0.1 n), 25)`. */
  gamma?: (n: number) => number;
  /** Weight of the prior (the whole range) in each estimator. Default 1. */
  priorWeight?: number;
  /** Seed for the sampler's own random numbers. Default 0. */
  seed?: number;
}

/** A number in `[low, high]`; `log` samples it on a log scale. */
export function float(
  low: number,
  high: number,
  options: { log?: boolean } = {},
): FloatParam {
  checkRange(low, high, options.log ?? false);
  return { type: "float", low, high, log: options.log ?? false };
}

/** An integer in `[low, high]`, both included. */
export function int(
  low: number,
  high: number,
  options: { log?: boolean } = {},
): IntParam {
  if (!Number.isInteger(low) || !Number.isInteger(high))
    throw new RangeError(`int bounds must be integers: ${low}, ${high}`);
  checkRange(low, high, options.log ?? false);
  return { type: "int", low, high, log: options.log ?? false };
}

/** One of `choices`, compared by identity. */
export function choice<const T>(choices: readonly T[]): ChoiceParam<T> {
  if (choices.length === 0)
    throw new RangeError("choice needs at least one option");
  return { type: "choice", choices };
}

function checkRange(low: number, high: number, log: boolean): void {
  if (!(Number.isFinite(low) && Number.isFinite(high) && low <= high))
    throw new RangeError(`invalid range: [${low}, ${high}]`);
  if (log && low <= 0)
    throw new RangeError(`a log range must be positive: [${low}, ${high}]`);
}

export class TpeSampler<S extends SearchSpace> {
  readonly trials: Array<Trial<S>> = [];
  private readonly random: () => number;
  private readonly sign: 1 | -1;
  private readonly startupTrials: number;
  private readonly candidates: number;
  private readonly gamma: (n: number) => number;
  private readonly priorWeight: number;

  readonly space: S;

  // A plain field, not a parameter property, so Node can strip the types and
  // run this file as it is.
  constructor(space: S, options: TpeOptions = {}) {
    this.space = space;
    this.random = mulberry32(options.seed ?? 0);
    this.sign = options.direction === "maximize" ? -1 : 1;
    this.startupTrials = options.startupTrials ?? 10;
    this.candidates = options.candidates ?? 24;
    this.gamma = options.gamma ?? ((n) => Math.min(Math.ceil(0.1 * n), 25));
    this.priorWeight = options.priorWeight ?? 1;
  }

  /** The next configuration to evaluate. */
  ask(): Config<S> {
    const config = {} as Record<string, unknown>;
    const told = this.trials.length;
    if (told < this.startupTrials) {
      for (const [name, param] of Object.entries(this.space))
        config[name] = this.sampleRandom(param);
      return config as Config<S>;
    }
    // Lower is better internally; a value that isn't finite (a failed trial)
    // sorts last and is never in the good group.
    const ranked = this.trials
      .map((trial) => ({ config: trial.config, loss: this.loss(trial.value) }))
      .sort((a, b) => a.loss - b.loss);
    const finite = ranked.filter((t) => Number.isFinite(t.loss)).length;
    if (finite === 0) {
      for (const [name, param] of Object.entries(this.space))
        config[name] = this.sampleRandom(param);
      return config as Config<S>;
    }
    const nGood = Math.max(1, Math.min(finite, told - 1, this.gamma(told)));
    const good = ranked.slice(0, nGood).map((t) => t.config);
    const bad = ranked.slice(nGood).map((t) => t.config);
    for (const [name, param] of Object.entries(this.space)) {
      const below = good.map((c) => (c as Record<string, unknown>)[name]);
      const above = bad.map((c) => (c as Record<string, unknown>)[name]);
      config[name] =
        param.type === "choice"
          ? this.sampleChoice(param, below, above)
          : this.sampleNumber(param, below as number[], above as number[]);
    }
    return config as Config<S>;
  }

  /** Records what `config` scored. `NaN` or `±Infinity` marks a failure. */
  tell(config: Config<S>, value: number): void {
    this.trials.push({ config, value });
  }

  /** The best trial told so far, ignoring failures. */
  get best(): Trial<S> | undefined {
    let best: Trial<S> | undefined;
    for (const trial of this.trials) {
      if (!Number.isFinite(trial.value)) continue;
      if (!best || this.sign * trial.value < this.sign * best.value)
        best = trial;
    }
    return best;
  }

  private loss(value: number): number {
    return Number.isFinite(value) ? this.sign * value : Infinity;
  }

  private sampleRandom(param: Param): unknown {
    if (param.type === "choice")
      return param.choices[Math.floor(this.random() * param.choices.length)];
    const [low, high] = internalBounds(param);
    return fromInternal(param, low + this.random() * (high - low));
  }

  private sampleNumber(
    param: FloatParam | IntParam,
    below: number[],
    above: number[],
  ): number {
    const [low, high] = internalBounds(param);
    if (low === high) return fromInternal(param, low);
    const l = this.parzen(
      below.map((v) => toInternal(param, v)),
      low,
      high,
    );
    const g = this.parzen(
      above.map((v) => toInternal(param, v)),
      low,
      high,
    );
    let bestX = low;
    let bestScore = -Infinity;
    for (let i = 0; i < this.candidates; i++) {
      const x = sampleMixture(l, low, high, this.random);
      const score =
        mixtureLogPdf(l, x, low, high) - mixtureLogPdf(g, x, low, high);
      if (score > bestScore) [bestX, bestScore] = [x, score];
    }
    return fromInternal(param, bestX);
  }

  /**
   * Hyperopt's adaptive Parzen estimator: one Gaussian per observation plus
   * a prior over the whole range, each as wide as the larger gap to its
   * neighbours, clipped to `[range / min(100, n + 1), range]`.
   */
  private parzen(observed: number[], low: number, high: number): Mixture {
    const range = high - low;
    const prior = {
      mu: (low + high) / 2,
      sigma: range,
      weight: this.priorWeight,
    };
    const components = [
      ...observed.map((mu) => ({ mu, sigma: 0, weight: 1 })),
      prior,
    ].sort((a, b) => a.mu - b.mu);
    const minSigma = range / Math.min(100, components.length);
    for (let i = 0; i < components.length; i++) {
      const component = components[i]!;
      if (component === prior) continue;
      const left = component.mu - (components[i - 1]?.mu ?? low);
      const right = (components[i + 1]?.mu ?? high) - component.mu;
      component.sigma = Math.min(range, Math.max(minSigma, left, right));
    }
    const total = components.reduce((sum, c) => sum + c.weight, 0);
    for (const component of components) component.weight /= total;
    return components;
  }

  private sampleChoice(
    param: ChoiceParam<unknown>,
    below: unknown[],
    above: unknown[],
  ): unknown {
    const l = this.choiceWeights(param, below);
    const g = this.choiceWeights(param, above);
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < this.candidates; i++) {
      const index = pickWeighted(l, this.random);
      const score = Math.log(l[index]!) - Math.log(g[index]!);
      if (score > bestScore) [best, bestScore] = [index, score];
    }
    return param.choices[best];
  }

  /** Each choice's probability: its count plus a share of the prior. */
  private choiceWeights(param: ChoiceParam<unknown>, observed: unknown[]) {
    const k = param.choices.length;
    const counts = param.choices.map(() => this.priorWeight / k);
    for (const value of observed) {
      const index = param.choices.indexOf(value);
      if (index >= 0) counts[index]! += 1;
    }
    const total = counts.reduce((sum, c) => sum + c, 0);
    return counts.map((c) => c / total);
  }
}

/** Runs `trials` evaluations of `objective` one after another. */
export async function optimize<S extends SearchSpace>(
  space: S,
  objective: (config: Config<S>) => number | Promise<number>,
  options: TpeOptions & { trials: number },
): Promise<{ best: Trial<S> | undefined; trials: Array<Trial<S>> }> {
  const sampler = new TpeSampler(space, options);
  for (let i = 0; i < options.trials; i++) {
    const config = sampler.ask();
    sampler.tell(config, await objective(config));
  }
  return { best: sampler.best, trials: sampler.trials };
}

// Internal space: log-scaled when `log`; an int widened by half a step each
// side so both ends are as likely as the values between.

function internalBounds(param: FloatParam | IntParam): [number, number] {
  const pad = param.type === "int" ? 0.5 : 0;
  const low = param.low - pad;
  const high = param.high + pad;
  // A log int's lower bound stays positive: `int(1, 8, { log: true })` → [0.5, 8.5].
  return param.log ? [Math.log(low), Math.log(high)] : [low, high];
}

function toInternal(param: FloatParam | IntParam, value: number): number {
  return param.log ? Math.log(value) : value;
}

function fromInternal(param: FloatParam | IntParam, x: number): number {
  const value = param.log ? Math.exp(x) : x;
  const clamped = Math.min(param.high, Math.max(param.low, value));
  return param.type === "int" ? Math.round(clamped) : clamped;
}

type Mixture = Array<{ mu: number; sigma: number; weight: number }>;

function mixtureLogPdf(
  mixture: Mixture,
  x: number,
  low: number,
  high: number,
): number {
  let density = 0;
  for (const { mu, sigma, weight } of mixture) {
    const mass = normalCdf((high - mu) / sigma) - normalCdf((low - mu) / sigma);
    const z = (x - mu) / sigma;
    density +=
      (weight * Math.exp(-0.5 * z * z)) /
      (sigma * Math.sqrt(2 * Math.PI) * Math.max(mass, 1e-12));
  }
  return Math.log(Math.max(density, Number.MIN_VALUE));
}

/**
 * A draw from the mixture truncated to `[low, high]`. Each component's mean
 * is inside the range and its width at most the range, so rejection accepts
 * at least a third of draws; the clamp is only a backstop.
 */
function sampleMixture(
  mixture: Mixture,
  low: number,
  high: number,
  random: () => number,
): number {
  const { mu, sigma } =
    mixture[
      pickWeighted(
        mixture.map((c) => c.weight),
        random,
      )
    ]!;
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = mu + sigma * standardNormal(random);
    if (x >= low && x <= high) return x;
  }
  return Math.min(high, Math.max(low, mu));
}

function pickWeighted(weights: readonly number[], random: () => number) {
  let r = random() * weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function standardNormal(random: () => number): number {
  // Box–Muller; `1 - random()` keeps the log's argument above zero.
  return (
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
  );
}

/** Φ(z), via Abramowitz and Stegun 7.1.26 (absolute error below 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** A small, fast, seedable PRNG; returns floats in `[0, 1)`. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
