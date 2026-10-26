#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serveSidecar } from "./sidecar.js";

export const SERVE_DEFAULTS = {
  fakes: "mcp/index.ts",
  scenarios: "scenarios/index.ts",
};

const USAGE = `Usage: mcp-fakes serve [--fakes <file>] [--scenarios <file>]

  serve        Serve the Recipe's fakes, configured from the MCP_FAKES_* environment:
               every fake on 0.0.0.0:7353 unless MCP_FAKES_HOST and MCP_FAKES_PORT say
               otherwise. Run it in the Recipe's fakes/, from the copy of this package
               the fakes import; Node runs their TypeScript as it is.
  --fakes      The module exporting \`fakes\` (${SERVE_DEFAULTS.fakes})
  --scenarios  The module exporting \`world\` (${SERVE_DEFAULTS.scenarios})`;

// The export `name` of the module at `file`, resolved from the working directory.
async function load(file: string, name: string) {
  const module = await import(pathToFileURL(path.resolve(file)).href);
  if (!(name in module)) throw new Error(`${file} exports no \`${name}\``);
  return module[name];
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fakes: { type: "string", default: SERVE_DEFAULTS.fakes },
      scenarios: { type: "string", default: SERVE_DEFAULTS.scenarios },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "serve") {
    console.error(USAGE);
    return 2;
  }
  await serveSidecar(await load(values.fakes, "fakes"), await load(values.scenarios, "world"));
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // As Node prints an uncaught error, so `introspection local` reads its message from the log.
  console.error(error);
  process.exitCode = 1;
}
