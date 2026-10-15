#!/usr/bin/env node
import { parseArgs } from "node:util";
import { BUNDLE_DEFAULTS, isCurrent, writeBundle } from "./bundle.js";

const USAGE = `Usage: mcp-fakes bundle [--fakes <file>] [--scenarios <file>] [--out <file>] [--check]

  bundle       Bundle the Harbor sidecar: the package's entrypoint over the Recipe's
               fakes and world, with every dependency, into one file the sidecar
               image runs with no install. Run it in the Recipe's fakes/.
  --fakes      The module exporting \`fakes\` (${BUNDLE_DEFAULTS.fakes})
  --scenarios  The module exporting \`world\` (${BUNDLE_DEFAULTS.scenarios})
  --out        The bundle (${BUNDLE_DEFAULTS.out})
  --check      Write nothing; fail when the bundle differs from what the sources
               bundle to now.`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fakes: { type: "string" },
      scenarios: { type: "string" },
      out: { type: "string", default: BUNDLE_DEFAULTS.out },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "bundle") {
    console.error(USAGE);
    return 2;
  }
  const options = { fakes: values.fakes, scenarios: values.scenarios };
  if (values.check) {
    if (await isCurrent(values.out, options)) return 0;
    const again = argv.filter((arg) => arg !== "--check").join(" ");
    console.error(`${values.out} is stale: run mcp-fakes ${again}`);
    return 1;
  }
  await writeBundle(values.out, options);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
