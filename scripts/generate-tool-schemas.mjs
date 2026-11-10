// Writes the JSON Schema of each first-party command tool's arguments from
// the TypeScript types that declare them, as part of the build (`pnpm
// schemas`, run wherever `pnpm manifest` is); the output is not committed.
import { readFileSync, writeFileSync } from "node:fs";

import * as prettier from "prettier";
import { createGenerator } from "ts-json-schema-generator";

const root = new URL("../", import.meta.url);
const SOURCES = [
  {
    source: "src/productivity/arguments.ts",
    output: "src/productivity/arguments.generated.ts",
    tools: {
      Mail: "MAIL_ARGUMENTS",
      Calendar: "CALENDAR_ARGUMENTS",
      Drive: "DRIVE_ARGUMENTS",
    },
  },
  {
    source: "src/channels/arguments.ts",
    output: "src/channels/arguments.generated.ts",
    tools: { Channels: "CHANNELS_ARGUMENTS" },
  },
  {
    source: "src/issues/arguments.ts",
    output: "src/issues/arguments.generated.ts",
    tools: { Issues: "ISSUES_ARGUMENTS" },
  },
  {
    source: "src/documents/arguments.ts",
    output: "src/documents/arguments.generated.ts",
    tools: { Documents: "DOCUMENTS_ARGUMENTS" },
  },
  // A tool with no commands names its one arguments type.
  {
    source: "src/search/arguments.ts",
    output: "src/search/arguments.generated.ts",
    single: { WebSearchArguments: "WEB_SEARCH_ARGUMENTS" },
  },
];

const snake = (name) =>
  name.replace(/(?<!^)[A-Z]/g, (letter) => `_${letter}`).toLowerCase();

/** The schema of one command's arguments, inlined and in a fixed key order. */
function commandSchema(generator, type) {
  const { properties = {}, required = [] } = generator.createSchema(type);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

async function generate({ source, output, tools = {}, single = {} }) {
  const text = readFileSync(new URL(source, root), "utf8");
  const generator = createGenerator({
    path: new URL(source, root).pathname,
    tsconfig: new URL("tsconfig.json", root).pathname,
    skipTypeCheck: true,
    expose: "none",
    topRef: false,
    jsDoc: "extended",
    additionalProperties: false,
  });
  const imports = [];
  const blocks = [];
  for (const [prefix, constant] of Object.entries(tools)) {
    const pattern = new RegExp(
      `^export (?:interface|type) (${prefix}(\\w+)Arguments)\\b`,
      "gm",
    );
    const entries = [...text.matchAll(pattern)].map(([, type, command]) => {
      imports.push(type);
      return `  ${snake(command)}: ${JSON.stringify(commandSchema(generator, type))} as ArgumentsSchema<${type}>,`;
    });
    if (entries.length === 0)
      throw new Error(`${source} declares no ${prefix} commands`);
    blocks.push(`export const ${constant} = {\n${entries.join("\n")}\n};`);
  }
  for (const [type, constant] of Object.entries(single)) {
    imports.push(type);
    blocks.push(
      `export const ${constant} = ${JSON.stringify(commandSchema(generator, type))} as ArgumentsSchema<${type}>;`,
    );
  }
  const from = `./${source.split("/").pop().replace(/\.ts$/, ".js")}`;
  const module = [
    `// Generated from ${source} by scripts/generate-tool-schemas.mjs; do not edit.`,
    `import type { ArgumentsSchema } from "../command-parameters.js";`,
    `import type { ${imports.join(", ")} } from "${from}";`,
    "",
    ...blocks,
    "",
  ].join("\n");
  const path = new URL(output, root);
  const options = (await prettier.resolveConfig(path.pathname)) ?? {};
  return {
    output,
    path,
    content: await prettier.format(module, {
      ...options,
      filepath: path.pathname,
    }),
  };
}

for (const entry of SOURCES) {
  const { path, content } = await generate(entry);
  let current;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  // Rewriting an unchanged file would make every watcher rebuild.
  if (current !== content) writeFileSync(path, content);
}
