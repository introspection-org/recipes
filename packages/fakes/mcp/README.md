# @introspection-ai/mcp-fakes

The host for a Recipe's MCP fakes. A fake stands in for an MCP server the
Recipe declares, during an eval run: it serves the tools the server's captured
`tools.ts` describes, validates every call against those schemas, and keeps
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
  package-lock.json       # what the sidecar image installs with npm ci
  Dockerfile              # the Harbor sidecar's image (below)
  mcp/
    index.ts              # every fake, imported statically
    attio/
      index.ts            # exports the fake's manifest, contract, register and observed
      tools.ts            # the captured tools/list (written by `introspection bindings mcp capture`)
      answers.ts          # each tool's successful answer, declared by hand
      contract.ts         # contractOf(tools, answers)
      observed.ts         # what the real server answered (written by `introspection bindings mcp observe`)
      entities.ts         # the fake's state type
      handlers.ts         # one SDK tool callback per allowed tool
      manifest.json       # server identity, capture, entity map
  scenarios/
    index.ts              # SCENARIOS and world(name, clock): every fake's starting state
  tests/
    fakes.test.js         # checkRecipeFakes (below)
    setup.js              # the recording's global setup and teardown
    responses.jsonl       # every answer the contract tests received
```

`mcp/index.ts` exports `fakes`, an object keyed by server id whose values are
the fakes' modules: each exports its `manifest`, its `contract`, its `register`
and, where it has an `observed.ts`, its `observed`. A fake's
`index.ts` re-exports `manifest.json` as imported, with no cast: `Manifest`
takes the strings a JSON import widens, and the host refuses a value the
protocol does not allow, such as an icon `theme` other than `light` or `dark`. A fake's id is
its directory under `mcp/` and the server id the Recipe declares in its
`package.json`. `scenarios/index.ts` exports `world(scenario, clock)` and the
scenarios by name.

## The contract

The CLI writes `tools.ts` and `observed.ts` as TypeScript modules whose default
export is the JSON `as const`, so TypeScript keeps every literal and TypeBox's
`Static` infers each schema's type:

```ts
// Written by `introspection bindings mcp capture`. Do not edit.
// biome-ignore-all format: the CLI writes this file and reads it back
// prettier-ignore
export default { "tools": [ … ] } as const;
```

A formatter may rewrite the object: the CLI reads it back as JSON5 and
compares values, not text.

A fake declares each tool's successful answer in `answers.ts`, an `Answer`: the
format the server answers in, `json`, `toon`, `prefixed_json` (JSON after the
fixed `prefix` and before the optional `suffix`) or `text`, and the TypeBox schema of the decoded value; a
`text` answer has none. `contract.ts` binds the two:

```ts
// answers.ts
import { Type } from 'typebox';

export const answers = {
  'send-email': {
    format: 'prefixed_json',
    prefix: 'Email sent successfully! ',
    schema: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  },
  'get-email': { format: 'text' },
};

// contract.ts
import { contractOf } from '@introspection-ai/mcp-fakes';
import { answers } from './answers.ts';
import tools from './tools.ts';

export const contract = contractOf(tools, answers);
export type Contract = typeof contract;
```

`contractOf` gives each tool, by name and in captured order, its entry: the
captured `tool` as it is served, its input schema (`args`), the `defaults` it
states, and its `answer`. A tool that states an `outputSchema` has that as its
answer, `{ format: 'json', schema: outputSchema }`, and declares none. The type
check fails when `answers` misses a tool or declares one for a tool with an
`outputSchema`; `contractOf` throws for those and for an answer of a tool not
captured. `typebox` 1 is a peer dependency.

| Type | Is |
| --- | --- |
| `Args<C, N>` | A tool's arguments as its handler receives them, the defaults the host fills required |
| `SentArgs<C, N>` | A tool's arguments as a caller sends them |
| `Result<C, N>` | A tool's decoded answer: its schema's `Static`, or the text of a `text` answer |
| `Answered<C>` | A call a fake answered, `{ name, args, result }`, narrowed by `name` |
| `Entry`, `Contract`, `Answer` | One tool's entry; every entry by name; a declared answer |

`observedOf(observed)` gives each tool of a fake's `observed.ts` its `sampled`
count and the `answer` the real server gave, in the same `Answer` shape, and a
code-mode tool each API operation's own under `operations`; a fake's `index.ts`
exports it as `observed` for `checkRecipeFakes`. That check holds a code-mode
tool's recorded call to the operation the arguments its manifest's `codeMode`
names select, and to the tool's own answer when they select no observed one.

## Writing a handler

`handlers.ts` registers its tools with the SDK directly. `toolsOf(contract)`
gives `config(name)`, which builds a tool's registration from its captured
entry and types the callback's arguments, and `answer(name, value)`, which
answers in the tool's declared format, its value typed by the answer's schema:

```ts
import { type McpServer, notImplemented, text, toolsOf } from '@introspection-ai/mcp-fakes';
import { contract } from './contract.ts';
import type { State } from './entities.ts';

const { config, answer } = toolsOf(contract);

export function register(server: McpServer, state: State) {
  server.registerTool('list-deals', config('list-deals'), async ({ limit, filter }) => {
    // `limit` is filled from the schema's default when the caller omits it.
    if (filter && filter.op !== 'eq') return notImplemented(`the filter op ${filter.op}`);
    return answer('list-deals', { deals: state.deals.slice(0, limit) }); // encoded as declared, TOON say
  });

  server.registerTool('get-deal', config('get-deal'), async ({ id }) =>
    answer('get-deal', { id, stage: 'Proposal' }), // states an outputSchema: structuredContent
  );
}
```

- **`config(name)`** carries the tool's title, description, annotations, icons
  and `_meta` as captured, and its input and output schemas wrapped with
  `fromJsonSchema`. It refuses a tool that is not captured, a tool that
  declares `execution` with `taskSupport` `optional` or `required` (the SDK
  cannot serve it), and an input schema that states a default below the top
  level (the host would not fill it). A tool declaring `"taskSupport":
  "forbidden"`, the protocol's default and what servers such as Attio declare
  on every tool, is served without `execution`, which means the same.
- **Register in captured order.** The SDK lists tools in the order they are
  registered, so the served list then matches the capture.
- **`answer(name, value)`** encodes the value in the tool's format
  (`encode`), putting a `prefixed_json` answer's prefix before its JSON; a tool
  that states an `outputSchema` answers with `structured(value)`. TOON is
  written by `@toon-format/toon`, with an empty array under a key or at the
  root rewritten from the library's `key: []` to the length form `key[0]:`,
  as the real server's encoder writes it (TOON spec 3.3 allows both). The
  canonical-TOON check in `observed.ts` uses the same encoder.
- **`text(value, isError?)`** builds a text result, for a tool error.
- **`structured<T>(value)`** builds the result of a tool that declares an
  output schema: the structured content, and its JSON as the text item.
- **`notImplemented(what)`** is the tool error for an argument value that
  selects a behaviour the handler does not implement, such as a filter
  operator: `This fake does not implement <what>.`
- **`labelId(label)`** derives a stable UUID from a readable label, so a
  world's ids are the same from run to run.
- **`toolConfig(tools)`** is the `config` under `toolsOf`, for a fake without
  a contract.

## Reading answers

`@introspection-ai/mcp-fakes/answers` reads a successful answer back: decoded
by its format and validated against its schema with TypeBox's compiled
validator. A Recipe's contract tests check every answer with it, and its eval
checks read the agent's tool results with it.

| Export | Returns |
| --- | --- |
| `readAnswer(answer, text)` | `{ ok: true, value }`, or `{ ok: false, error, issues }` for text not in the answer's format or a value outside its schema |
| `readResult(entry, { text, structured })` | The same for one tool of a contract, read where its answer is: the `structuredContent` of a tool that states an `outputSchema`, whose text is ignored, as the Recipes MCP wrapper and `observe` read it; the text of any other |
| `answered(fake, calls)` | The calls the fake answered, typed by its contract as `Answered`; a refused call is left out, and a successful answer outside the contract throws, since it makes the measurement invalid |

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
services.mcpServers(); // [{ id: 'attio', transport: 'streamable_http', url: services.url('attio') }, …]
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
same name, in captured order. The sidecar image is built from
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

## Talking to the agent against the fakes

`introspection local` runs a Recipe against its fakes with `mcp-fakes serve`, so a
Recipe needs no launcher of its own:

```bash
introspection local --agent agent --scenario quiet                       # every fake
introspection local --agent agent --scenario quiet --fakes attio,resend  # only these
introspection local --agent agent --fakes attio,resend                   # world's default scenario
```

The CLI starts `mcp-fakes serve` in `fakes/`, from the copy of this package the
fakes resolve (install the fakes' dependencies first), on a free loopback port, waits for
`/health`, and binds only the selected fakes; a server the Recipe declares
`required: true` that is not among them stops the run. Pi runs in
`.introspection/local/<scenario>/workspace`, which holds the binding, so the
Recipe checkout is not written to, and every fake's state is written to
`.introspection/local/<scenario>/state.json` (`_default` without
`--scenario`). The sidecar stops when Pi exits.

## In a vitest eval

A Recipe's vitest eval starts its fakes itself, through the hooks of
`@introspection-ai/vitest-evals`' `createRecipeHarness`: `beforeRun` starts a
fresh world for each Pi session and binds it, and `collectArtifacts`, which
runs after every turn, including a failed one, records each fake's state:

```ts
// evals/vitest/lib/harness.ts
import { type Services, startServices } from '@introspection-ai/mcp-fakes';
import { createRecipeHarness, type RecipeEvalInput } from '@introspection-ai/vitest-evals';
import { fakes } from '../../../fakes/mcp/index.ts';
import { type World, world } from '../../../fakes/scenarios/index.ts';

export const harness = (scenario: string) =>
  createRecipeHarness<RecipeEvalInput, Services<World>>({
    beforeRun: async () => {
      const services = await startServices(fakes, { world, scenario });
      return { mcpServers: services.mcpServers(), fixture: services, teardown: services.close };
    },
    collectArtifacts: ({ fixture }) => ({
      fakeStates: { initial: fixture.initial, final: structuredClone(fixture.states) },
    }),
  });
```

- `mcpServers()` binds every fake it serves, as
  `{ id, transport: 'streamable_http', url }` on loopback. To bind only some,
  pass only those to `startServices`.
- The handlers change `states` in place, so a turn's artifact takes a copy; a
  continued run shares the session's fakes, and its final state holds every
  turn so far.
- `teardown` runs once when the test finishes, so a continued run still
  reaches the fakes.
- The artifacts are JSON: a `World` declared as an `interface` is not
  assignable to `JsonValue`, so declare it as a `type`, or cast it.

What the agent called is in the run itself (vitest-evals'
`toolCalls(run.session)`), not in the fakes, which keep only their state.

## Checking a run

`@introspection-ai/mcp-fakes/verify` holds the two checks a Recipe's cases
share. It imports only Node built-ins, not the MCP SDK or a test
runner, so a judge or a `node --test` file can import it:

```ts
import { fileURLToPath } from 'node:url';
import { changedEntities, type FakeStates, loadManifests, writeAttempts } from '@introspection-ai/mcp-fakes/verify';
import { toolCalls } from 'vitest-evals';

const manifests = loadManifests(fileURLToPath(new URL('../../../fakes/mcp', import.meta.url)));
const crm = { attio: manifests.attio };

const states = run.artifacts.fakeStates as FakeStates<World>;
changedEntities(states, { attio: manifests.attio, resend: manifests.resend });
// ['resend.sendAttempts']: no state changed when empty
writeAttempts(toolCalls(run.session), crm);
// the calls to a CRM write tool, each with `server` and `tool`: no write attempted when empty
```

| Export | Returns |
| --- | --- |
| `loadManifests(directory)` | `{ id: manifest }` from `<directory>/<id>/manifest.json`; throws when the directory is missing or holds no manifest |
| `changedEntities(states, manifests)` | `['<id>.<entity>', …]`: every entity some tool of these fakes writes whose final state differs from the initial one |
| `writeAttempts(calls, manifests)` | The calls to a tool the write maps say writes, each with its `server` (fake id) and its contract `tool` name |
| `piToolNames(server, tool)` | The names Pi gives an MCP tool: hashed, and the readable form |
| `FakeStates<T>`, `WriteMap`, `WriteAttempt<T>` | `{ initial, final }` keyed by fake id; the manifest fields the checks read; a call with its `server` and `tool` |

`changedEntities` and `writeAttempts` throw on an empty set of manifests
rather than report nothing, so a missing manifest never scores a pass. States
compare as JSON values, so `false` and `0` differ.

- **"No state changed" reads state.** The written entities include outbound
  effects such as sent emails and the send attempts a mail fake rejected. A
  rejected write or a no-op call is no change; a change undone within the run
  is not seen, so a case that forbids a temporary change records each
  transition in the fake's state.
- **"No write attempted" is an attempt check.** It counts a call to a write
  tool whether or not the call changed anything, so name and score it as an
  attempt, beside the state check rather than instead of it. A call is matched
  by the name Pi gives the tool, from the fake's id (its directory under
  `fakes/mcp/`, which is the server id the Recipe declares) and the tool's
  contract name; `readOnlyHint` plays no part.

This package's tests run the checks on the cases in this repository's
`integrations/testdata/fakes/cases.json`, which a Harbor verifier's port of
them runs too, so the two runners score a run alike.

## The Harbor sidecar

`mcp-fakes serve` serves the Recipe's fakes: it imports `fakes` from
`mcp/index.ts` and `world` from `scenarios/index.ts` (`--fakes` and
`--scenarios` name other paths) and calls `serveSidecar`. Node runs the fakes'
TypeScript with type stripping, so nothing is built; the fakes import each
other with `.ts` specifiers. Run it in `fakes/`, from the copy of this package
the fakes import, as the image does:

```dockerfile
FROM docker.io/library/node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7353
CMD ["node_modules/.bin/mcp-fakes", "serve"]
```

The image installs from the npm registry while it builds, so the plane's build
egress must allow `registry.npmjs.org`. Pinned by the committed
`package-lock.json`, two builds of one commit serve the same code. An unpinned
`node:22-slim` resolves onto the plane's vetted base where it has one.

The sidecar serves every fake on `0.0.0.0:7353` (`SIDECAR_PORT`), so a trial
binds a fake at `http://fakes:7353/<id>/mcp`. It reads its settings from the
environment:

| Variable | Meaning |
| --- | --- |
| `MCP_FAKES_SCENARIO` | The scenario `world` builds; `world`'s default when unset |
| `MCP_FAKES_PORT`, `MCP_FAKES_HOST` | Where to listen; `7353` on `0.0.0.0` |
| `MCP_FAKES_STATE_FILE` | `stateFile` |
| `MCP_FAKES_RECORD` | `record` |
| `MCP_FAKES_MANIFEST_DIR` | A directory each fake's manifest and answers are written to at start, as `mcp/<id>/manifest.json` for the verifier's write-map checks and `mcp/<id>/answers.json` for reading the agent's tool results |

`answers.json` holds each tool's answer from the fake's contract, by tool
name: its `format`, the `prefix` of a `prefixed_json` answer, its `schema` (a
TypeBox schema is JSON Schema, so it is written as it is) and `structured:
true` for a tool that states an `outputSchema`, whose answer is its
`structuredContent`. `introspection_harbor.answers` in the Harbor adapter reads
it to check an answer as `readResult` does, without TypeScript.

`serveSidecar(fakes, world)` is that entrypoint, for a Recipe that writes its
own. Under vitest the fakes start with `startServices` on an ephemeral port
instead ([In a vitest eval](#in-a-vitest-eval)).

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
| `<id> serves the Recipe's allowed tools from its contract, in captured order` | `tools/list` differs from the captured tools the Recipe's `pi.mcp.servers[].tools` allows (an `include` of `"*"` or a tool's name, less its `exclude`), in captured order; a captured `"taskSupport": "forbidden"` equals a tool served without `execution` |
| `<id> maps every allowed tool to its entities` | The manifest's `tools` are not the allow-list, a tool's kind is not `stateful` or `static`, it names an entity outside `entities`, or its writes contradict `readOnlyHint` |
| `<id> has no static tool over an entity a tool writes or a world fills` | A static tool writes, or reads an entity some tool writes or some scenario's world fills |
| `<id> refuses a call outside a tool's input schema and changes no state` | A call the captured input schema refuses (its required arguments left out, an undeclared argument, or one of the wrong type) is answered, or changes the fake's state |
| `<id> shares no state between two started instances` | Two instances' states share an object; with `recording`, its calls to the fake replayed on one instance change the other's state, or leave the two in different states once replayed on both |
| `<id> answers every observed tool as the real server did` | With `recording`, for a fake that exports `observed`: an observed tool has no recorded successful answer, or one reads unlike the observed answer (below) |
| `the <scenario> world is consistent` | The world lacks a fake's state, or `consistent` throws |
| `an unknown scenario is refused` | `world` builds a world for a name it does not know |

| Option | Default | Meaning |
| --- | --- | --- |
| `test` | required | The runner's `test` |
| `recipe` | required | The Recipe's root `package.json` |
| `fakes`, `world`, `scenarios` | required | `mcp/index.ts`'s `fakes`, `scenarios/index.ts`'s `world`, and the scenario names or the object keyed by them |
| `consistent` | none | The Recipe's own invariants of a world; throws when one fails |
| `clock` | now | The clock the worlds are built at |
| `recording` | none | The JSONL file the contract tests record every answer to |
| `timeout` | `60000` | Each test's timeout in milliseconds |

The captured tools come from each fake's `contract`. An observed answer is
read as `introspection bindings mcp observe` read the real server: a tool that
states an `outputSchema` from its `structuredContent`, any other from its text
in the observed format; a wrong type, string format or result format fails; a
key every sample held fails when missing only once the tool was sampled
`REQUIRED_MIN_SAMPLES` (3) times; an extra key is allowed; and the value of a
key the observed schema masked is held to its `x-masked-values`, again only
after `REQUIRED_MIN_SAMPLES` samples. Since `observe` keeps a key that is a
plain lowercase-first word by name, a key the schema does not list is held to
`x-masked-values` only when it is not such a word: a sample that lacked it says
nothing about its value. TOON must
also be written exactly as the TOON encoder writes it wherever every observed
result was (`canonical`); prefixed JSON is held to the observed text before
and after the JSON (`prefix`, `suffix`, or one of `prefixes`, `suffixes`); and
a `text` answer to its observed first line (`prefix` or one of `prefixes`). A
`mixed` answer is only counted. An allowed tool `observed` holds no
observation of is named in a warning on stderr, not failed, since nothing
checks its answers.

This package's own tests cover what every host does: the captured
tools served in order, arguments validated against the captured schema
(formats included), defaults filled, an unread argument ignored, an
unimplemented value refused as a tool error, an unknown tool, the output
schema enforced, the state routes and file, recording, the start-up check,
configs from a second loaded copy of the package, and `mcp-fakes serve` over
the TypeScript fakes as they are. A Recipe does not repeat them.

### The fake's contract tests

What only the Recipe knows, its fake's semantics, it tests itself: an empty
and a missing result, pagination, a read after a write, an injected failure.
`@introspection-ai/mcp-fakes/testing` calls the fakes with the official MCP
client, `@modelcontextprotocol/client` 2.3.1 (the version of the
`@modelcontextprotocol/server` this host is built on), an optional peer
dependency the Recipe's `fakes/` adds as a dev dependency; the host's own
import path never loads it.

```js
// fakes/tests/client.js
export const RECORD = new URL('./responses.jsonl', import.meta.url).pathname;
export const options = { clock: '2026-10-01T09:00:00.000Z', record: RECORD };

// fakes/tests/setup.js: node --test --test-global-setup=tests/setup.js tests/*.test.js
import { recording } from '@introspection-ai/mcp-fakes/testing';
import { RECORD } from './client.js';

export const { globalSetup, globalTeardown } = recording(RECORD);

// fakes/tests/notes.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, callTool, withFakes } from '@introspection-ai/mcp-fakes/testing';
import { fakes } from '../mcp/index.ts';
import { world } from '../scenarios/index.ts';
import { options } from './client.js';

test('a note written is read back', () =>
  withFakes(fakes, world, 'quiet', async ({ notes, states }) => {
    await call(notes, 'create-note', { title: 'Renewal' });
    const read = await callTool(notes, 'get-note', { id: 'note-4' });
    assert.deepEqual(read.structured, { id: 'note-4', title: 'Renewal' });
    assert.equal(states.notes.notes.length, 4);
  }, options));
```

| Export | Does |
| --- | --- |
| `withFakes(fakes, world, scenario, fn, { clock, record })` | Starts fresh fakes for the scenario, connects a client to each, and calls `fn` with the clients by fake id, `states` and `services`; closes them all after |
| `connect(services, id)` | An official MCP client connected to one fake |
| `callTool(client, name, args)` | `{ text, isError, structured? }`; a successful answer must be the tool's contract answer (`readResult`), or it throws |
| `call(client, name, args)` | The text of a successful call; a tool error throws with its text |
| `recording(file)` | `{ globalSetup, globalTeardown }`: empties the recording before the run and sorts its lines after, so the committed file does not change with the order the test files ran in |

A tool error, such as a schema rejection, is a result with `isError: true`; a
call to a tool the fake does not serve rejects with the JSON-RPC error. Pass the
recording to `checkRecipeFakes` as `recording`.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```
