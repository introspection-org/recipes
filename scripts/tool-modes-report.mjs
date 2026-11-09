#!/usr/bin/env node
// Summarizes the tool-mode recordings (test/recordings/tool-modes/<set>/<model>/)
// into report.md and two charts, cost.svg and time.svg, for the newest set.
// Prices come from Pi's model catalog, so cost follows the recorded model.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "test", "recordings", "tool-modes");
const MODES = [
  ["tools", "tools"],
  ["tools-deferred", "tools + defer"],
  ["codemode", "codemode"],
  ["cli", "cli"],
];
const MODELS = [
  ["claude-haiku-5-5", "Haiku 5.5", "anthropic"],
  ["claude-sonnet-5-5", "Sonnet 5.5", "anthropic"],
  ["claude-opus-5-5", "Opus 5.5", "anthropic"],
  ["gpt-6-luna", "gpt-6-luna", "openai"],
  ["gpt-6.1-sol", "gpt-6.1-sol", "openai"],
  ["gpt-6-astra", "gpt-6-astra", "openai"],
];
// One ramp per provider, darker for the more capable model: Anthropic's orange,
// OpenAI's grays. Adjacent shades are validated for color-vision deficiency;
// every bar carries its value, which the palest shades need.
const COLORS = [
  "#f6bd9d",
  "#d97757",
  "#8a3618",
  "#c9c7be",
  "#77756e",
  "#141413",
];
const SETS = ["flat", "signatures"];

const catalogDir = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "providers",
  "data",
);

/** $ per million tokens: input, output, cache read, cache write. */
function prices(id, provider) {
  const data = JSON.parse(
    readFileSync(join(catalogDir, `${provider}.json`), "utf8"),
  );
  for (const models of Object.values(data))
    for (const model of Object.values(models))
      if (model.id === id) return model.cost;
  throw new Error(`No price for ${provider}/${id} in Pi's catalog`);
}

/** One run's cassette: model time, rejected calls, and whether a draft came back. */
function cassette(har) {
  const entries = JSON.parse(readFileSync(har, "utf8")).log.entries;
  const seconds = entries.reduce((sum, e) => sum + (e.time ?? 0), 0) / 1000;
  const last = JSON.parse(entries.at(-1).request.postData.text);
  let errors = 0;
  let drafted = false;
  for (const item of [...(last.messages ?? []), ...(last.input ?? [])]) {
    const blocks = Array.isArray(item.content) ? item.content : [item];
    for (const block of blocks) {
      if (
        ![
          "tool_result",
          "function_call_output",
          "custom_tool_call_output",
        ].includes(block?.type)
      )
        continue;
      const text = JSON.stringify(block.content ?? block.output ?? "");
      if (block.is_error || text.includes("Validation failed")) errors += 1;
      if (/draft\\*"\s*:\s*\\*"msg_/.test(text)) drafted = true;
    }
  }
  return { seconds, errors, drafted };
}

function runs(set, id) {
  const dir = join(DIR, set, id);
  if (!existsSync(dir)) return {};
  const byMode = {};
  for (const [mode] of MODES) {
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".summary.json"))
      .map((f) => f.slice(0, -".summary.json".length))
      .filter((n) => n === mode || new RegExp(`^${mode}\\.\\d+$`).test(n));
    byMode[mode] = names.map((name) => {
      const totals = JSON.parse(
        readFileSync(join(dir, `${name}.summary.json`), "utf8"),
      ).totals;
      const folder = readdirSync(dir).find((f) =>
        f.startsWith(`${name.replaceAll(".", "-")}_`),
      );
      return { totals, ...cassette(join(dir, folder, "recording.har")) };
    });
  }
  return byMode;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function row(id, provider, list) {
  const p = prices(id, provider);
  const cost = list.map(
    ({ totals: t }) =>
      (t.input_tokens * p.input +
        t.cache_creation_input_tokens * (p.cacheWrite ?? p.input) +
        t.cache_read_input_tokens * (p.cacheRead ?? p.input) +
        t.output_tokens * p.output) /
      1e6,
  );
  const input = list.map(
    ({ totals: t }) =>
      t.input_tokens +
      t.cache_creation_input_tokens +
      t.cache_read_input_tokens,
  );
  return {
    runs: list.length,
    drafted: list.filter((r) => r.drafted).length,
    errors: mean(list.map((r) => r.errors)),
    requests: mean(list.map((r) => r.totals.requests)),
    input: mean(input),
    cached: mean(
      list.map(
        ({ totals: t }, i) => t.cache_read_input_tokens / Math.max(input[i], 1),
      ),
    ),
    output: mean(list.map((r) => r.totals.output_tokens)),
    costPerTask: mean(cost),
    seconds: mean(list.map((r) => r.seconds)),
  };
}

const table = {};
for (const set of SETS)
  for (const [id, , provider] of MODELS)
    for (const [mode, list] of Object.entries(runs(set, id)))
      if (list.length)
        (table[set] ??= {})[`${id}|${mode}`] = row(id, provider, list);

/** Dollars to three significant figures, so a fraction of a cent still reads. */
const usd = (n) =>
  `$${n >= 1 ? fmt(n, 2) : n.toFixed(Math.max(2, 2 - Math.floor(Math.log10(n))))}`;

const fmt = (n, d = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

let md = "";
for (const set of SETS) {
  if (!table[set]) continue;
  md += `### ${set}\n\n| model | mode | runs | drafted (errors) | requests | input | cached | output | $ / task | time |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const [id, name] of MODELS)
    for (const [mode, label] of MODES) {
      const r = table[set][`${id}|${mode}`];
      if (!r) continue;
      md += `| ${name} | ${label} | ${r.runs} | ${r.drafted}/${r.runs} (${fmt(r.errors, r.errors % 1 ? 1 : 0)}) | ${fmt(r.requests, 1)} | ${fmt(r.input)} | ${fmt(r.cached * 100)}% | ${fmt(r.output)} | ${usd(r.costPerTask)} | ${fmt(r.seconds, 1)}s |\n`;
    }
  md += "\n";
}
writeFileSync(join(DIR, "report.md"), md);

/**
 * One group per mode, one bar per model, on one scale for every model. On a
 * log scale a bar starts at the axis's first decade, not at zero.
 */
function chart(set, value, title, unit, digits, log = false) {
  const W = 760;
  const left = 120;
  const right = 190;
  const barH = 14;
  const gap = 2;
  const groupGap = 18;
  const top = 64;
  const present = MODELS.filter(([id]) =>
    MODES.some(([m]) => table[set]?.[`${id}|${m}`]),
  );
  const groupH = present.length * (barH + gap) - gap;
  const H = top + MODES.length * (groupH + groupGap) + 52;
  const values = Object.values(table[set] ?? {}).map((r) => r[value]);
  const max = Math.max(...values);
  const lo = Math.floor(Math.log10(Math.min(...values)));
  const hi = Math.ceil(Math.log10(max));
  const x = log
    ? (v) => left + ((Math.log10(v) - lo) / (hi - lo)) * (W - left - right)
    : (v) => left + (v / max) * (W - left - right);
  const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">\n`;
  svg += `<rect width="${W}" height="${H}" fill="#faf9f5"/>\n`;
  svg += `<text x="16" y="26" font-size="15" font-weight="600" fill="#141413">${esc(title)}</text>\n`;
  let lx = 16;
  present.forEach(([, name], i) => {
    svg += `<rect x="${lx}" y="38" width="10" height="10" rx="2" fill="${COLORS[MODELS.findIndex(([, n]) => n === name)]}" stroke="#0000001f"/><text x="${lx + 14}" y="47" font-size="12" fill="#5e5d59">${esc(name)}</text>\n`;
    lx += 26 + name.length * 7;
  });
  // A horizontal axis: 1-3 steps per decade on a log scale, round steps on a linear one.
  const ticks = log
    ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).flatMap((p) =>
        p < hi ? [10 ** p, 3 * 10 ** p] : [10 ** p],
      )
    : (() => {
        // A round step (1, 2 or 5 times a power of ten) giving about five ticks.
        const raw = max / 5;
        const power = 10 ** Math.floor(Math.log10(raw));
        const step =
          power * ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10);
        return Array.from(
          { length: Math.floor(max / step + 1e-9) + 1 },
          (_, i) => Number((i * step).toPrecision(6)),
        );
      })();
  const money = value === "costPerTask";
  const tickLabel = (v) =>
    money
      ? v === 0
        ? "$0"
        : `$${Number(v.toPrecision(2))}`
      : `${fmt(v, v % 1 ? 1 : 0)}${unit}`;
  for (const v of ticks) {
    const gx = x(v);
    svg += `<line x1="${gx}" y1="${top - 6}" x2="${gx}" y2="${H - 46}" stroke="#e8e6dc"/><text x="${gx}" y="${H - 32}" font-size="10" text-anchor="middle" fill="#5e5d59">${tickLabel(v)}</text>\n`;
  }
  svg += `<line x1="${left}" y1="${H - 46}" x2="${W - right}" y2="${H - 46}" stroke="#b0aea5"/>\n`;
  MODES.forEach(([mode, label], g) => {
    const gy = top + g * (groupH + groupGap);
    svg += `<text x="${left - 10}" y="${gy + groupH / 2 + 4}" font-size="12" text-anchor="end" fill="#141413">${esc(label)}</text>\n`;
    present.forEach(([id], i) => {
      const r = table[set]?.[`${id}|${mode}`];
      if (!r) return;
      const y = gy + i * (barH + gap);
      const w = Math.max(x(r[value]) - left, 1);
      const color = COLORS[MODELS.findIndex(([m]) => m === id)];
      svg += `<rect x="${left}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" stroke="#0000001f"/>\n`;
      // Quality rides on the label: a bar that didn't finish every run, or made rejected calls, says so.
      const quality = [
        ...(r.drafted < r.runs ? [`${r.drafted}/${r.runs} drafted`] : []),
        ...(r.errors > 0 ? [`${fmt(r.errors, 1)} errors/run`] : []),
      ];
      svg += `<text x="${left + w + 6}" y="${y + barH - 3}" font-size="11" stroke="#faf9f5" stroke-width="3" paint-order="stroke" fill="${quality.length ? "#b3261e" : "#45453f"}">${money ? usd(r[value]) : `${fmt(r[value], digits)}${unit}`}${quality.length ? ` · ${quality.join(", ")}` : ""}</text>\n`;
    });
  });
  svg += `<text x="${left}" y="${H - 14}" font-size="12" fill="#5e5d59">${esc(value === "seconds" ? "Seconds of model time per task: lower is better." : `USD per task at list price${log ? ", log scale" : ""}: lower is better.`)} <tspan fill="#b3261e">Red</tspan>: missed drafts or rejected calls.</text>\n`;
  return `${svg}</svg>\n`;
}

const newest = SETS.filter((set) => table[set]).at(-1);

/**
 * Intelligence against cost: each model at its cheapest setting that passed
 * every run, against its Intelligence Index at the effort the runs used.
 * Up and to the left is better. Cost is on a log scale, as the index's own
 * chart draws it.
 */
function intelligence(set) {
  const lookup = JSON.parse(
    readFileSync(process.env.INTELLIGENCE_JSON, "utf8"),
  );
  const points = MODELS.flatMap(([id, name], i) => {
    const score = lookup.models[id]?.low;
    const passing = MODES.map(([mode, label]) => ({
      label,
      row: table[set]?.[`${id}|${mode}`],
    })).filter(
      ({ row }) => row && row.drafted === row.runs && row.errors === 0,
    );
    if (score === undefined || !passing.length) return [];
    const best = passing.reduce((a, b) =>
      a.row.costPerTask <= b.row.costPerTask ? a : b,
    );
    return [
      {
        name,
        mode: best.label,
        cost: best.row.costPerTask,
        score,
        color: COLORS[i],
      },
    ];
  });
  const W = 760;
  const H = 440;
  const left = 70;
  const right = 40;
  const top = 64;
  const bottom = 70;
  const lo = Math.floor(Math.log10(Math.min(...points.map((p) => p.cost))));
  const hi = Math.ceil(Math.log10(Math.max(...points.map((p) => p.cost))));
  const yMax =
    Math.ceil(Math.max(...points.map((p) => p.score)) / 10) * 10 + 10;
  const x = (v) =>
    left + ((Math.log10(v) - lo) / (hi - lo)) * (W - left - right);
  const y = (v) => H - bottom - (v / yMax) * (H - top - bottom);
  const esc = (t) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">\n`;
  svg += `<rect width="${W}" height="${H}" fill="#faf9f5"/>\n`;
  svg += `<text x="16" y="26" font-size="15" font-weight="600" fill="#141413">Intelligence against cost per task</text>\n`;
  svg += `<text x="16" y="46" font-size="12" fill="#5e5d59">${esc(lookup.index)} at low effort, the effort the runs used; each model at its cheapest mode that passed every run</text>\n`;
  for (let v = 0; v <= yMax; v += 10) {
    svg += `<line x1="${left}" y1="${y(v)}" x2="${W - right}" y2="${y(v)}" stroke="#e8e6dc"/><text x="${left - 8}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="#5e5d59">${v}</text>\n`;
  }
  for (let p = lo; p <= hi; p++)
    for (const m of p < hi ? [1, 3] : [1]) {
      const v = m * 10 ** p;
      svg += `<line x1="${x(v)}" y1="${top}" x2="${x(v)}" y2="${H - bottom}" stroke="#e8e6dc"/><text x="${x(v)}" y="${H - bottom + 16}" font-size="10" text-anchor="middle" fill="#5e5d59">$${Number(v.toPrecision(1))}</text>\n`;
    }
  svg += `<line x1="${left}" y1="${H - bottom}" x2="${W - right}" y2="${H - bottom}" stroke="#b0aea5"/>\n`;
  // A label that would overlap one already placed goes below its point.
  const placed = [];
  for (const point of points) {
    const text = `${point.name} · ${point.mode} · ${usd(point.cost)}`;
    const box = (dy) => ({
      x0: x(point.cost) + 11,
      x1: x(point.cost) + 11 + text.length * 6.2,
      y0: y(point.score) + dy - 10,
      y1: y(point.score) + dy + 4,
    });
    const hits = (b) =>
      placed.some(
        (p) => b.x0 < p.x1 && p.x0 < b.x1 && b.y0 < p.y1 && p.y0 < b.y1,
      );
    point.dy = [4, 20, -12].find((dy) => !hits(box(dy))) ?? 4;
    placed.push(box(point.dy));
  }
  for (const point of points) {
    svg += `<circle cx="${x(point.cost)}" cy="${y(point.score)}" r="7" fill="${point.color}" stroke="#0000003d"/>\n`;
  }
  for (const point of points) {
    svg += `<text x="${x(point.cost) + 11}" y="${y(point.score) + point.dy}" font-size="11" stroke="#faf9f5" stroke-width="3" paint-order="stroke" fill="#141413">${esc(point.name)} · ${esc(point.mode)} · ${usd(point.cost)}</text>\n`;
  }
  svg += `<text x="${left}" y="${H - 34}" font-size="12" fill="#5e5d59">USD per task at list price, log scale. Up and to the left is better.</text>\n`;
  svg += `<text x="${left}" y="${H - 16}" font-size="11" fill="#5e5d59">Index scores: ${esc(lookup.source)}, read ${esc(lookup.read)}.</text>\n`;
  svg += `<text transform="translate(20 ${(top + H - bottom) / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#5e5d59">Intelligence Index (low effort)</text>\n`;
  return `${svg}</svg>\n`;
}
writeFileSync(
  join(DIR, "cost.svg"),
  chart(newest, "costPerTask", "Cost per task, by tool mode", "", 2, true),
);
writeFileSync(
  join(DIR, "time.svg"),
  chart(newest, "seconds", "Model time per task, by tool mode", "s", 1),
);
// Index scores aren't ours to commit; with a lookup file, the chart is drawn beside it.
if (process.env.INTELLIGENCE_JSON)
  writeFileSync(
    process.env.INTELLIGENCE_JSON.replace(/\.json$/, ".svg"),
    intelligence(newest),
  );
console.log(`report.md, cost.svg and time.svg from the ${newest} set`);
