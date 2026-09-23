# introspection-recipe-check

Pure structural validation for portable [Recipe](https://pi.recipes) packages.

The checker validates the portable authored contract:

- the `package.json#pi` manifest and its resource paths;
- agent YAML shape, names, and `from` inheritance;
- each agent's explicit stable `name`, required resolved `model.name`, and any
  declared skill or subagent references;
- package and agent MCP authorization policy;
- direct-child `judges/*.yaml` definitions and their typed authored schema;
- dependency lockfile presence and npm lockfile identity;
- exclusion of local capability configuration from distributable snapshots.

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

## License

Apache-2.0
