import { describe, expect, it } from "vitest";

import {
  choice,
  float,
  int,
  optimize,
  TpeSampler,
  type Config,
} from "../src/tuning/tpe.js";

const SPACE = {
  x: float(-5, 5),
  lr: float(1e-5, 1e-1, { log: true }),
  layers: int(1, 8),
  optimizer: choice(["adam", "sgd", "rmsprop"]),
};

/** Minimum 0 at x = 2, lr = 1e-3, layers = 3, optimizer = "adam". */
function objective(config: Config<typeof SPACE>): number {
  return (
    (config.x - 2) ** 2 +
    (Math.log10(config.lr) + 3) ** 2 +
    (config.layers - 3) ** 2 / 4 +
    (config.optimizer === "adam" ? 0 : 1)
  );
}

describe("TpeSampler", () => {
  it("asks only for values inside the space", () => {
    const sampler = new TpeSampler(SPACE, { startupTrials: 5 });
    for (let i = 0; i < 60; i++) {
      const config = sampler.ask();
      expect(config.x).toBeGreaterThanOrEqual(-5);
      expect(config.x).toBeLessThanOrEqual(5);
      expect(config.lr).toBeGreaterThanOrEqual(1e-5);
      expect(config.lr).toBeLessThanOrEqual(1e-1);
      expect(Number.isInteger(config.layers)).toBe(true);
      expect(config.layers).toBeGreaterThanOrEqual(1);
      expect(config.layers).toBeLessThanOrEqual(8);
      expect(["adam", "sgd", "rmsprop"]).toContain(config.optimizer);
      sampler.tell(config, objective(config));
    }
  });

  it("reaches both ends of an int range", () => {
    const sampler = new TpeSampler({ n: int(1, 3) }, { startupTrials: 200 });
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(sampler.ask().n);
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it("repeats the same search for the same seed", async () => {
    const run = (seed: number) =>
      optimize(SPACE, objective, { trials: 30, seed });
    expect((await run(7)).trials).toEqual((await run(7)).trials);
    expect((await run(7)).trials).not.toEqual((await run(8)).trials);
  });

  it("beats random search on the same budget", async () => {
    const seeds = [1, 2, 3, 4, 5];
    let tpe = 0;
    let random = 0;
    for (const seed of seeds) {
      const options = { trials: 80, seed };
      tpe += (await optimize(SPACE, objective, options)).best!.value;
      // All startup trials: random search with the same draws.
      random += (
        await optimize(SPACE, objective, { ...options, startupTrials: 80 })
      ).best!.value;
    }
    expect(tpe / seeds.length).toBeLessThan(random / seeds.length / 2);
    expect(tpe / seeds.length).toBeLessThan(0.5);
  });

  it("maximizes when asked", async () => {
    const { best } = await optimize(
      { x: float(0, 10) },
      ({ x }) => -((x - 7) ** 2),
      { trials: 60, direction: "maximize" },
    );
    expect(best!.config.x).toBeCloseTo(7, 0);
  });

  it("counts a failed trial as bad and never as best", async () => {
    const { best, trials } = await optimize(
      { x: float(0, 10) },
      ({ x }) => (x < 5 ? NaN : (x - 8) ** 2),
      { trials: 40 },
    );
    expect(best!.config.x).toBeGreaterThanOrEqual(5);
    // After startup it moves away from the failing half.
    const late = trials.slice(-15).filter((t) => Number.isNaN(t.value));
    expect(late.length).toBeLessThan(5);
  });

  it("rejects invalid ranges", () => {
    expect(() => float(1, 0)).toThrow(RangeError);
    expect(() => float(0, 1, { log: true })).toThrow(RangeError);
    expect(() => int(0.5, 2)).toThrow(RangeError);
    expect(() => choice([])).toThrow(RangeError);
  });
});
