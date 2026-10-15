# @introspection-ai/mcp-fakes

The host for a Recipe's MCP fakes. A fake stands in for an MCP server the
Recipe declares, during an eval run: it serves the tools the server's captured
`tools.json` describes, validates every call against those schemas, and keeps
its state where the eval's checks can read it. One process serves every fake
of a Recipe, so a task needs one sidecar and one port however many servers the
Recipe declares.

The package is built on the official MCP TypeScript SDK, version 2
(`@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node`). It
serves the captured JSON Schemas as they are, through `fromJsonSchema`; no
schema passes through zod.

## The fakes it serves

A Recipe's `fakes/` holds one directory per server under `mcp/`, named by the
server id the Recipe declares:

```text
fakes/
  package.json            # depends on @introspection-ai/mcp-fakes
  Dockerfile              # the Harbor sidecar's image (below)
  dist/sidecar.js         # the sidecar, bundled by `mcp-fakes bundle`, committed
  mcp/
    index.ts              # every fake, imported statically
    attio/
      index.ts            # exports the fake's manifest and register
      tools.json          # the captured tools/list (written by the CLI)
      contract.ts         # the tools' TypeScript types (written by the CLI)
      entities.ts         # the fake's state type
      handlers.ts         # one SDK tool callback per allowed tool
      manifest.json       # server identity, capture, entity map
  scenarios/
    index.ts              # SCENARIOS and world(name, clock): every fake's starting state
  tests/
    fakes.test.js         # checkRecipeFakes (below)
```

`mcp/index.ts` exports `fakes`, an object keyed by server id whose values are
the fakes' modules: each exports its `manifest` and `register`. A fake's id is
its directory under `mcp/` and the server id the Recipe declares in its
`package.json`. `scenarios/index.ts` exports `world(scenario, clock)` and the
scenarios by name.

## Writing a handler

`handlers.ts` registers its tools with the SDK directly. `toolConfig` binds the
fake's `tools.json` and its generated `Contract`, and returns `config(name)`,
which builds a tool's registration from its captured entry:

```ts
import { type McpServer, notImplemented, structured, text, toolConfig } from '@introspection-ai/mcp-fakes';
import type { Contract } from './contract.ts';
import type { State } from './entities.ts';
import tools from './tools.json' with { type: 'json' };

const config = toolConfig<Contract>(tools);

export function register(server: McpServer, state: State) {
  server.registerTool('list-deals', config('list-deals'), async ({ limit, filter }) => {
    // `limit` is filled from the schema's default when the caller omits it.
    if (filter && filter.op !== 'eq') return notImplemented(`the filter op ${filter.op}`);
    return text(state.deals.slice(0, limit).map((deal) => deal.name).join('\n'));
  });

  server.registerTool('get-deal', config('get-deal'), async ({ id }) =>
    structured<Contract['get-deal']['result']>({ id, stage: 'Proposal' }),
  );
}
```

- **`config(name)`** carries the tool's title, description, annotations, icons
  and `_meta` as captured, and its input and output schemas wrapped with
  `fromJsonSchema`. It refuses a tool that is not in `tools.json`, a tool that
  declares `execution` (the SDK cannot serve it), and an input schema that
  states a default below the top level (the host would not fill it).
- **Register in the order `tools.json` gives.** The SDK lists tools in the
  order they are registered, so the served list then matches the capture.
- **`text(value, isError?)`** builds a text result.
- **`structured<T>(value)`** builds the result of a tool that declares an
  output schema: the structured content, and its JSON as the text item. Type it
  with the result `contract.ts` generated.
- **`notImplemented(what)`** is the tool error for an argument value that
  selects a behaviour the handler does not implement, such as a filter
  operator: `This fake does not implement <what>.`
- **`labelId(label)`** derives a stable UUID from a readable label, so a
  world's ids are the same from run to run.

## What every call goes through

1. The SDK validates the arguments against the captured schema with its ajv
   validator, which picks the draft by the schema's `$schema` and enforces
   formats.
2. The host fills the defaults the schema states on top-level arguments the
   call omits.
3. The handler runs. An argument it does not read is ignored.
4. Where the tool declares an output schema, the SDK checks the result against
   it.
5. The host writes the state, when asked to.

A call to a tool the fake does not serve is a JSON-RPC error
(`-32602 Tool <name> not found`), and a validation error is worded the SDK's
way (`Input validation error: Invalid arguments for tool <name>: data/limit
must be <= 50`).

## Starting the fakes

```ts
import { startServices } from '@introspection-ai/mcp-fakes';
import { fakes } from './mcp/index.ts';
import { world } from './scenarios/index.ts';

const services = await startServices(fakes, { world, scenario: 'blocked', port: 0 });
services.url('attio'); // http://127.0.0.1:<port>/attio/mcp
services.states.attio; // the current state, changed in place by the handlers
services.initial.attio; // the state it started with
await services.close();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `world` | required | The Recipe's `world(scenario, clock)`: every fake's starting state, keyed by fake id |
| `scenario` | `world`'s own default | The scenario to build |
| `clock` | now | The clock every date of the world is computed from |
| `port` | `0` (ephemeral) | The port to listen on |
| `host` | `127.0.0.1` | The address to listen on; a sidecar sets `0.0.0.0` |
| `stateFile` | none | A file every fake's state is written to, keyed by fake id, after each MCP request |
| `record` | none | A file each tool call is appended to as one JSON line |

The world is fixed when the services start; nothing loads a world into a
running fake, and a state file is never read back.

### Routes

| Route | Serves |
| --- | --- |
| `/<id>/mcp` | The fake's MCP endpoint (Streamable HTTP) |
| `/<id>/admin/state` | The fake's current state |
| `/<id>/admin/initial-state` | The state it started with |
| `/health` | `{"ok":true}` |

### The start-up check

`startServices` refuses to start unless, for each fake, the handlers register
exactly the tools in its manifest's `tools`, each with `config(name)` for that
same name, in the order of `tools.json`. The sidecar image is built from
`fakes/` alone and cannot read the Recipe's manifest, so the fake's manifest
is the list the host compares against; a test of the Recipe pins that list to
its allow-list. It also refuses a fake the world holds no state for.

### Recording calls

With `record`, each tool call is appended as one JSON line, in the shape
`introspection bindings mcp observe --examples` writes, plus the fake it was
made to:

```json
{"server":"attio","tool":"list-records","args":{"object":"deals","limit":50},"result":{"content":[{"type":"text","text":"…"}]}}
```

`args` is what the caller sent, before defaults are filled, and `result` is the
`CallToolResult` as the fake returned it. A call answered with a JSON-RPC error
is recorded with `result` holding it: `{"error":{"code":-32602,"message":"…"}}`.
Recording is off unless asked; the fake keeps no call log otherwise.

## The Harbor sidecar

A plane builds the Harbor sidecar's image with no route to a package registry,
so the image installs nothing. The package carries the sidecar's entrypoint;
the bundler compiles it over the Recipe's fakes and world, with the host and
every dependency, into one file the Recipe commits. Run it in `fakes/`:

```sh
npx mcp-fakes bundle            # writes dist/sidecar.js
npx mcp-fakes bundle --check    # exits 1 when dist/sidecar.js is stale
```

`--fakes` (default `mcp/index.ts`), `--scenarios` (`scenarios/index.ts`) and
`--out` (`dist/sidecar.js`) name other paths. Rebuild after any change under
`fakes/` or a version bump of this package. The Recipe needs no entrypoint
file; the image copies `fakes/` and runs the bundle:

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY . .
EXPOSE 7353
CMD ["node", "/app/dist/sidecar.js"]
```

The sidecar serves every fake on `0.0.0.0:7353` (`SIDECAR_PORT`), so a trial
binds a fake at `http://fakes:7353/<id>/mcp`. It reads its settings from the
environment:

| Variable | Meaning |
| --- | --- |
| `MCP_FAKES_SCENARIO` | The scenario `world` builds; `world`'s default when unset |
| `MCP_FAKES_PORT`, `MCP_FAKES_HOST` | Where to listen; `7353` on `0.0.0.0` |
| `MCP_FAKES_STATE_FILE` | `stateFile` |
| `MCP_FAKES_RECORD` | `record` |
| `MCP_FAKES_MANIFEST_DIR` | A directory each fake's manifest is written to at start, as `mcp/<id>/manifest.json`, for the verifier's write-map checks |

`serveSidecar(fakes, world)` is that entrypoint, for a Recipe that writes its
own. Under vitest the fakes start with `startServices` on an ephemeral port
instead.

## The tests a Recipe keeps

`checkRecipeFakes` registers the checks every Recipe keeps about its own
fakes with the runner's `test`, `node:test`'s or vitest's:

```js
// fakes/tests/fakes.test.js
import { test } from 'node:test';
import { checkRecipeFakes } from '@introspection-ai/mcp-fakes/checks';
import { fakes } from '../mcp/index.ts';
import { SCENARIOS, world } from '../scenarios/index.ts';

checkRecipeFakes({
  test,
  recipe: new URL('../../package.json', import.meta.url),
  fakes,
  world,
  scenarios: SCENARIOS,
  consistent: (world, scenario) => { /* throw when a record points at a missing one */ },
});
```

| Test | Fails when |
| --- | --- |
| `<id> serves the Recipe's allowed tools from tools.json, in captured order` | `tools/list` differs from the captured tools the Recipe's `pi.mcp.servers[].tools.include` names, in `tools.json`'s order |
| `<id> maps every allowed tool to its entities` | The manifest's `tools` are not the allow-list, a tool's kind is not `stateful` or `static`, it names an entity outside `entities`, or its writes contradict `readOnlyHint` |
| `<id> has no static tool over an entity a tool writes or a world fills` | A static tool writes, or reads an entity some tool writes or some scenario's world fills |
| `the <scenario> world is consistent` | The world lacks a fake's state, or `consistent` throws |
| `an unknown scenario is refused` | `world` builds a world for a name it does not know |
| `the committed sidecar bundle is current` | `dist/sidecar.js` differs from what the sources bundle to now |

| Option | Default | Meaning |
| --- | --- | --- |
| `test` | required | The runner's `test` |
| `recipe` | required | The Recipe's root `package.json` |
| `fakes`, `world`, `scenarios` | required | `mcp/index.ts`'s `fakes`, `scenarios/index.ts`'s `world`, and the scenario names or the object keyed by them |
| `consistent` | none | The Recipe's own invariants of a world; throws when one fails |
| `clock` | now | The clock the worlds are built at |
| `fakesDir` | `fakes/` beside `recipe` | The fakes' directory |
| `bundle` | `{}` | `{ fakes, scenarios, out }` relative to `fakesDir`, as the bundler takes them; `false` skips the check |
| `timeout` | `60000` | Each test's timeout in milliseconds |

`contract.ts` matching `tools.json` is `introspection bindings mcp types
--check`'s. This package's own tests cover what every host does: the captured
tools served in order, arguments validated against the captured schema
(formats included), defaults filled, an unread argument ignored, an
unimplemented value refused as a tool error, an unknown tool, the output
schema enforced, the state routes and file, recording, the start-up check,
configs from a second loaded copy of the package, and the bundle, the sidecar
and `--check`. A Recipe does not repeat them.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```
