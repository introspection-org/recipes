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
    costPerThousand: mean(cost) * 1000,
    seconds: mean(list.map((r) => r.seconds)),
  };
}

const table = {};
for (const set of SETS)
  for (const [id, , provider] of MODELS)
    for (const [mode, list] of Object.entries(runs(set, id)))
      if (list.length)
        (table[set] ??= {})[`${id}|${mode}`] = row(id, provider, list);

const fmt = (n, d = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

let md = "";
for (const set of SETS) {
  if (!table[set]) continue;
  md += `### ${set}\n\n| model | mode | runs | drafted (errors) | requests | input | cached | output | $ / 1,000 tasks | time |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const [id, name] of MODELS)
    for (const [mode, label] of MODES) {
      const r = table[set][`${id}|${mode}`];
      if (!r) continue;
      md += `| ${name} | ${label} | ${r.runs} | ${r.drafted}/${r.runs} (${fmt(r.errors, r.errors % 1 ? 1 : 0)}) | ${fmt(r.requests, 1)} | ${fmt(r.input)} | ${fmt(r.cached * 100)}% | ${fmt(r.output)} | ${fmt(r.costPerThousand, 2)} | ${fmt(r.seconds, 1)}s |\n`;
    }
  md += "\n";
}
writeFileSync(join(DIR, "report.md"), md);

/**
 * One group per mode, one mark per model, on one scale for every model. A
 * linear scale draws bars; a log scale draws dots, since a bar's length
 * claims a zero a log axis doesn't have.
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
        const step =
          [1, 2, 5, 10, 20, 50, 100].find((t) => max / t <= 6) ?? 100;
        return Array.from(
          { length: Math.floor(max / step) + 1 },
          (_, i) => i * step,
        );
      })();
  const tickLabel = (v) =>
    v > 0 && v < 1 ? v.toFixed(1) : `${fmt(Math.round(v))}${log ? "" : unit}`;
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
      svg += log
        ? `<line x1="${left}" y1="${y + barH / 2}" x2="${left + w}" y2="${y + barH / 2}" stroke="#e8e6dc"/><circle cx="${left + w}" cy="${y + barH / 2}" r="5.5" fill="${color}" stroke="#0000003d"/>\n`
        : `<rect x="${left}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" stroke="#0000001f"/>\n`;
      // Quality rides on the label: a bar that didn't finish every run, or made rejected calls, says so.
      const quality = [
        ...(r.drafted < r.runs ? [`${r.drafted}/${r.runs} drafted`] : []),
        ...(r.errors > 0 ? [`${fmt(r.errors, 1)} errors/run`] : []),
      ];
      svg += `<text x="${left + w + (log ? 10 : 6)}" y="${y + barH - 3}" font-size="11" stroke="#faf9f5" stroke-width="3" paint-order="stroke" fill="${quality.length ? "#b3261e" : "#45453f"}">${fmt(r[value], digits)}${unit}${quality.length ? ` · ${quality.join(", ")}` : ""}</text>\n`;
    });
  });
  svg += `<text x="${left}" y="${H - 14}" font-size="12" fill="#5e5d59">${esc(value === "seconds" ? "Seconds of model time per task: lower is better." : `USD per 1,000 tasks at list price${log ? ", log scale" : ""}: lower is better.`)} <tspan fill="#b3261e">Red</tspan>: missed drafts or rejected calls.</text>\n`;
  return `${svg}</svg>\n`;
}

const newest = SETS.filter((set) => table[set]).at(-1);
writeFileSync(
  join(DIR, "cost.svg"),
  chart(
    newest,
    "costPerThousand",
    "Cost per 1,000 tasks, by tool mode",
    "",
    2,
    true,
  ),
);
writeFileSync(
  join(DIR, "time.svg"),
  chart(newest, "seconds", "Model time per task, by tool mode", "s", 1),
);
console.log(`report.md, cost.svg and time.svg from the ${newest} set`);
