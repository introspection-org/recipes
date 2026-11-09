#!/usr/bin/env node
// Summarizes the tool-mode recordings (test/recordings/tool-modes/<set>/<model>/)
// into report.md and two charts, cost.svg and time.svg, for the newest set.
// Prices come from Pi's model catalog, so cost follows the recorded model.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
const SETS = ["flat", "signatures", "signatures-medium", "signatures-high"];
// The signature sets by reasoning effort; the mode charts use low, the fixture's default.
const EFFORTS = [
  ["signatures", "low"],
  ["signatures-medium", "medium"],
  ["signatures-high", "high"],
];

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

/** Introspection's mark and name, at the top right of a chart `width` wide. */
function brand(width) {
  const x0 = width - 142;
  return `<g transform="translate(${x0} 12) scale(0.75)" fill="none" stroke="#141413" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/></g><text x="${x0 + 24}" y="27" font-size="16" font-family="Georgia, serif" fill="#141413">Introspection</text>\n`;
}

/** Dollars to three significant figures, so a fraction of a cent still reads. */
const usd = (n) =>
  `$${n >= 1 ? fmt(n, 2) : n.toFixed(Math.max(2, 2 - Math.floor(Math.log10(n))))}`;

const fmt = (n, d = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const header = `| model | mode | runs | drafted (errors) | requests | input | cached | output | $ / task | time |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
const line = (name, label, r) =>
  `| ${name} | ${label} | ${r.runs} | ${r.drafted}/${r.runs} (${fmt(r.errors, r.errors % 1 ? 1 : 0)}) | ${fmt(r.requests, 1)} | ${fmt(r.input)} | ${fmt(r.cached * 100)}% | ${fmt(r.output)} | ${usd(r.costPerTask)} | ${fmt(r.seconds, 1)}s |\n`;
let md = "";
// With signatures: every effort in one table, the effort beside the model.
md += `### signatures\n\n${header}`;
for (const [id, name] of MODELS)
  for (const [set, effort] of EFFORTS)
    for (const [mode, label] of MODES) {
      const r = table[set]?.[`${id}|${mode}`];
      if (r) md += line(`${name} (${effort})`, label, r);
    }
md += "\n";
if (table.flat) {
  md += `### flat\n\n${header}`;
  for (const [id, name] of MODELS)
    for (const [mode, label] of MODES) {
      const r = table.flat[`${id}|${mode}`];
      if (r) md += line(`${name} (low)`, label, r);
    }
  md += "\n";
}
writeFileSync(join(DIR, "report.md"), md);

const passed = (r) => r.drafted === r.runs && r.errors === 0;

/** Whether a fill is light enough to take dark hatching. */
const light = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
};

/**
 * Grouped horizontal bars, one bar per model, on one scale for every model.
 * `groups` is `[{ label, bars: [{ id, row, note? }] }]`. The chart's winner,
 * the lowest `value` among every bar whose runs all passed, is hatched over
 * its own colour. On a log scale a bar starts at the axis's first decade.
 */
function chart(groups, value, title, unit, digits, log = false) {
  const W = 760;
  const left = 120;
  const right = 190;
  const barH = 14;
  const gap = 2;
  const groupGap = 18;
  const top = 64;
  const present = MODELS.filter(([id]) =>
    groups.some((g) => g.bars.some((b) => b.id === id)),
  );
  const groupH = present.length * (barH + gap) - gap;
  const H = top + groups.length * (groupH + groupGap) + 68;
  const values = groups.flatMap((g) => g.bars.map((b) => b.row[value]));
  const max = Math.max(...values);
  const lo = Math.floor(Math.log10(Math.min(...values)));
  const hi = Math.ceil(Math.log10(max));
  const x = log
    ? (v) => left + ((Math.log10(v) - lo) / (hi - lo)) * (W - left - right)
    : (v) => left + (v / max) * (W - left - right);
  const esc = (t) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">\n`;
  svg += `<defs>${["light", "dark"]
    .map(
      (k) =>
        `<pattern id="win-${k}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="2.5" height="6" fill="${k === "light" ? "#141413" : "#ffffff"}" opacity="${k === "light" ? 0.4 : 0.6}"/></pattern>`,
    )
    .join("")}</defs>\n`;
  svg += `<rect width="${W}" height="${H}" fill="#faf9f5"/>\n`;
  svg += `<text x="16" y="26" font-size="15" font-weight="600" fill="#141413">${esc(title)}</text>\n`;
  svg += brand(W);
  let lx = 16;
  present.forEach(([, name]) => {
    svg += `<rect x="${lx}" y="38" width="10" height="10" rx="2" fill="${COLORS[MODELS.findIndex(([, n]) => n === name)]}" stroke="#0000001f"/><text x="${lx + 14}" y="47" font-size="12" fill="#5e5d59">${esc(name)}</text>\n`;
    lx += 26 + name.length * 7;
  });
  svg += `<rect x="${lx}" y="38" width="10" height="10" rx="2" fill="url(#win-light)" stroke="#0000001f"/><text x="${lx + 14}" y="47" font-size="12" fill="#5e5d59">${value === "seconds" ? "fastest" : "cheapest"} that passed</text>\n`;
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
    svg += `<line x1="${gx}" y1="${top - 6}" x2="${gx}" y2="${H - 62}" stroke="#e8e6dc"/><text x="${gx}" y="${H - 48}" font-size="10" text-anchor="middle" fill="#5e5d59">${tickLabel(v)}</text>\n`;
  }
  svg += `<line x1="${left}" y1="${H - 62}" x2="${W - right}" y2="${H - 62}" stroke="#b0aea5"/>\n`;
  const winner = groups
    .flatMap((g) => g.bars)
    .filter((b) => passed(b.row))
    .reduce((a, b) => (!a || b.row[value] < a.row[value] ? b : a), null);
  groups.forEach((group, g) => {
    const gy = top + g * (groupH + groupGap);
    svg += `<text x="${left - 10}" y="${gy + groupH / 2 - 2}" font-size="12" text-anchor="end" fill="#141413" font-weight="${group.bars.includes(winner) ? 600 : 400}">${esc(group.label)}</text>\n`;
    present.forEach(([id], i) => {
      const bar = group.bars.find((b) => b.id === id);
      if (!bar) return;
      const r = bar.row;
      const y = gy + i * (barH + gap);
      const w = Math.max(x(r[value]) - left, 1);
      const color = COLORS[MODELS.findIndex(([m]) => m === id)];
      svg += `<rect x="${left}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" stroke="#0000001f"/>\n`;
      if (bar === winner)
        svg += `<rect x="${left}" y="${y}" width="${w}" height="${barH}" rx="3" fill="url(#win-${light(color) ? "light" : "dark"})"/>\n`;
      // Quality rides on the label: a bar that didn't finish every run, or made rejected calls, says so.
      const quality = [
        ...(r.drafted < r.runs ? [`${r.drafted}/${r.runs} drafted`] : []),
        ...(r.errors > 0 ? [`${fmt(r.errors, 1)} errors/run`] : []),
      ];
      svg += `<text x="${left + w + 6}" y="${y + barH - 3}" font-size="11" stroke="#faf9f5" stroke-width="3" paint-order="stroke" fill="${quality.length ? "#b3261e" : "#45453f"}">${money ? usd(r[value]) : `${fmt(r[value], digits)}${unit}`}${bar.note ? ` · ${esc(bar.note)}` : ""}${quality.length ? ` · ${quality.join(", ")}` : ""}</text>\n`;
    });
  });
  svg += `<text x="${left}" y="${H - 30}" font-size="12" fill="#5e5d59">${esc(value === "seconds" ? "Seconds of model time per task: lower is better." : `USD per task at list price${log ? ", log scale" : ""}: lower is better.`)} <tspan fill="#b3261e">Red</tspan>: missed drafts or rejected calls.</text>\n`;
  svg += `<text x="${left}" y="${H - 14}" font-size="11" fill="#5e5d59">Hatched, the recommendation: the ${value === "seconds" ? "fastest" : "cheapest"} setting on the chart whose every run drafted the reply with no rejected calls.</text>\n`;
  return `${svg}</svg>\n`;
}

/** The low-effort grid: one group per tool mode. */
const byMode = MODES.map(([mode, label]) => ({
  label,
  bars: MODELS.flatMap(([id]) => {
    const row = table.signatures?.[`${id}|${mode}`];
    return row ? [{ id, row }] : [];
  }),
}));

/**
 * One group per effort; each model at its best mode at that effort: the
 * cheapest (or fastest) that passed, else its cheapest, so a miss still shows.
 */
const byEffort = (value) =>
  EFFORTS.filter(([set]) => table[set]).map(([set, effort]) => ({
    label: `${effort} effort`,
    bars: MODELS.flatMap(([id]) => {
      if (
        !EFFORTS.every(
          ([s]) => !table[s] || MODES.some(([m]) => table[s][`${id}|${m}`]),
        )
      )
        return [];
      const options = MODES.flatMap(([mode, label]) => {
        const row = table[set][`${id}|${mode}`];
        return row ? [{ id, row, note: label }] : [];
      });
      if (!options.length) return [];
      const pool = options.some((o) => passed(o.row))
        ? options.filter((o) => passed(o.row))
        : options;
      return [pool.reduce((a, b) => (b.row[value] < a.row[value] ? b : a))];
    }),
  }));

const newest = "signatures";

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
  svg += brand(W);
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
  // Four equal quadrants: the middle of each axis, the cost axis in log space.
  const midCost = 10 ** ((lo + hi) / 2);
  const midScore = yMax / 2;
  svg += `<rect x="${left}" y="${top}" width="${x(midCost) - left}" height="${y(midScore) - top}" fill="#e3f1dc" opacity="0.75"/>\n`;
  svg += `<rect x="${x(midCost)}" y="${y(midScore)}" width="${W - right - x(midCost)}" height="${H - bottom - y(midScore)}" fill="#efede6" opacity="0.8"/>\n`;
  // The Pareto line: each model no cheaper model beats on intelligence.
  const frontier = [...points]
    .sort((a, b) => a.cost - b.cost)
    .reduce(
      (line, p) =>
        !line.length || p.score > line.at(-1).score ? [...line, p] : line,
      [],
    );
  svg += `<polyline points="${frontier.map((p) => `${x(p.cost)},${y(p.score)}`).join(" ")}" fill="none" stroke="#141413" stroke-width="1.5" stroke-dasharray="1 4" stroke-linecap="round"/>\n`;
  svg += `<rect x="${W - right - 300}" y="${top + 8}" width="12" height="12" rx="2" fill="#e3f1dc" stroke="#0000001f"/><text x="${W - right - 283}" y="${top + 18}" font-size="11" fill="#5e5d59">Most attractive quadrant</text>\n`;
  svg += `<line x1="${W - right - 140}" y1="${top + 14}" x2="${W - right - 112}" y2="${top + 14}" stroke="#141413" stroke-width="1.5" stroke-dasharray="1 4" stroke-linecap="round"/><text x="${W - right - 106}" y="${top + 18}" font-size="11" fill="#5e5d59">Pareto line</text>\n`;
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
  // The source's logo, as its own chart carries it: only the file's shapes are kept.
  svg += `<text x="${left}" y="${H - 34}" font-size="12" fill="#5e5d59">USD per task at list price, log scale. Up and to the left is better.</text>\n`;
  // The credit line: the index's logo and name, when given, then its source.
  // Only the logo file's shapes are kept.
  let credit = left;
  if (lookup.logo) {
    const paths =
      readFileSync(
        join(dirname(process.env.INTELLIGENCE_JSON), lookup.logo),
        "utf8",
      ).match(/<path\b[^>]*\/>/g) ?? [];
    const name = lookup.credit ?? "";
    svg += `<g transform="translate(${left} ${H - 27}) scale(0.24)">${paths.join("")}</g><text x="${left + 16}" y="${H - 16}" font-size="12" font-family="Georgia, serif" fill="#5e5d59">${esc(name)}</text>\n`;
    credit = left + 16 + name.length * 5.05 + 6;
  }
  svg += `<text x="${credit}" y="${H - 16}" font-size="11" fill="#5e5d59">Intelligence Index scores: ${esc(lookup.source)}, read ${esc(lookup.read)}.</text>\n`;
  svg += `<text transform="translate(20 ${(top + H - bottom) / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#5e5d59">Intelligence Index (low effort)</text>\n`;
  return `${svg}</svg>\n`;
}
writeFileSync(
  join(DIR, "cost.svg"),
  chart(
    byMode,
    "costPerTask",
    "Cost per task, by tool mode (low effort)",
    "",
    2,
    true,
  ),
);
writeFileSync(
  join(DIR, "time.svg"),
  chart(
    byMode,
    "seconds",
    "Model time per task, by tool mode (low effort)",
    "s",
    1,
  ),
);
if (EFFORTS.filter(([set]) => table[set]).length > 1) {
  writeFileSync(
    join(DIR, "effort-cost.svg"),
    chart(
      byEffort("costPerTask"),
      "costPerTask",
      "Cost per task, by reasoning effort",
      "",
      2,
      true,
    ),
  );
  writeFileSync(
    join(DIR, "effort-time.svg"),
    chart(
      byEffort("seconds"),
      "seconds",
      "Model time per task, by reasoning effort",
      "s",
      1,
    ),
  );
}
// Index scores aren't ours to commit; with a lookup file, the chart is drawn beside it.
if (process.env.INTELLIGENCE_JSON)
  writeFileSync(
    process.env.INTELLIGENCE_JSON.replace(/\.json$/, ".svg"),
    intelligence(newest),
  );
console.log(`report.md, cost.svg and time.svg from the ${newest} set`);
