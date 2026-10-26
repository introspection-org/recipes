# introspection-recipe-check

Pure structural validation for portable [Recipe](https://pi.recipes) packages.

The checker validates the portable authored contract:

- the `package.json#pi` manifest and its resource paths;
- agent YAML shape, names, and `from` inheritance;
- each agent's explicit stable `name`, required resolved `model.name`, and any
  declared skill or subagent references;
- package and agent MCP authorization policy;
- direct-child `judges/*.yaml` definitions (`online`, `offline` and `mission`) and their typed authored schema;
- dependency lockfile presence and npm lockfile identity;
- exclusion of local capability configuration from distributable snapshots,
  accepting a committed `.pi/mcp.local.json` only as a loopback evaluation
  binding.

It also warns, without failing the check, about vitest-evals judges that grade
the final message by text matching (see below).

It deliberately does not validate host manifests, credentials, deployment
resources, licenses, or local endpoint bindings. The exported `resources`
module separately provides the shared, pure Kubernetes-style quantity checker
used by hosts; those values are not part of the Recipe Format.

## I/O-free API

The core API accepts an in-memory snapshot and never touches the filesystem:

```rust
use introspection_recipe_check::{check_recipe_files, RecipeFile, RecipeFiles};

let input = RecipeFiles {
    files: vec![
        RecipeFile::new(
            "package.json",
            r#"{ "name": "demo", "pi": { "agents": ["agents/*.yaml"] } }"#,
        ),
        RecipeFile::new("agents/agent.yaml", "name: agent\n..."),
    ],
    directories: Vec::new(),
};
let report = check_recipe_files(&input);
assert!(!report.valid);
```

The `introspection-recipe-check` binary is a private snapshot-in/snapshot-out bridge
for hosts that shell out to the checker rather than linking it. It is not a
user-facing filesystem CLI. It is no longer shipped inside
`@introspection-ai/recipes`, and `pi --recipe` does not validate at startup:
validation belongs where it can be acted on - while authoring, in CI, and in
the host before it starts a session. Embed this crate directly, or use the
`introspection-recipe-check` Python binding, to validate from a host.

Diagnostics include a stable code, Recipe-relative path, optional 1-based
source span, message, and optional help text.

`introspection_recipe_check::spec` exports the normalized judge types and, with the optional
`schema` feature, their JSON Schema. Judge execution remains host-owned.

## Judges that match the final message's text

In `evals/vitest/**/*.ts`, each `createJudge(...)` imported from `vitest-evals`
is inspected. When its callback text matches the judged `output` — destructured
as `({ output })`, aliased as `({ output: text })`, or read as `args.output` —
the checker reports the warning `eval.judge_output_text_match`. Text matching
means `/re/.test(output)`, `new RegExp(...).test(output)`, `re.exec(output)`, or
`output.match`, `.matchAll`, `.search`, `.includes`, `.startsWith` or
`.endsWith`, also after `.toLowerCase()`, `.trim()` and similar. Matching on
tool calls or fake state is not reported.

Such a judge scores the wording of the final message, which is almost always a
proxy for a semantic outcome. Score only objective contracts (tool calls, fake
state), and leave semantic outcomes unscored, listed under `## Uncovered` in
`evals/vitest/README.md`, until a judge validated on production traces exists.

When the literal text is an approved requirement, opt out with a comment
directly above the `createJudge` statement, giving the reason:

```ts
// recipe-check: literal-output the refund policy requires the exact ticket ID
const QuotesTicket = createJudge<Input, string>('quotes the ticket ID', ({ output }) => ({
  score: /RF-\d+/.test(output) ? 1 : 0,
}));
```

An opt-out without a reason does not suppress the warning and is itself
reported as `eval.judge_literal_output_reason_missing`. Files whose content the
host did not supply are skipped.

## License

Apache-2.0
