# @introspection-ai/recipe-documents-docx

The Word (`.docx`) format for the Recipes [`documents` tool](../../../docs/documents/README.md):
`read`, `propose_edits`, `comment`, `respond` and `remove_section`, on paper-docx, and
the creating side of `convert`: a new `.docx` built from another format's outline, such
as a PDF to redline. `render` is not registered.

Recipes installs this package alongside itself (an `optionalDependencies` entry), so a
Recipe that declares the format without listing the package uses that copy, with its Python
environment and profiles. Declare it in `peerDependencies` (`"@introspection-ai/recipe-documents-docx": ">=X.Y.Z"`), which says the
platform provides it. To pin an exact version, list `"@introspection-ai/recipe-documents-docx": "X.Y.Z"` in
`dependencies` instead, and the Recipe's copy wins. `X.Y.Z` stands for a released version (`npm view @introspection-ai/recipe-documents-docx version`): a peer takes an open floor, `>=X.Y.Z`, and a pin an exact version.

## With and without a profile

The tool is the same either way: the same commands, the same checks, and the original
is never changed. A profile only adds guidance the agent reads.

**Without a profile** — any Word work: editing a policy, filling a template, marking up
a memo, answering comments.

```json
{ "pi": { "documents": [{ "format": "docx" }] } }
```

The agent gets the core `documents` skill: which command fits which change, how to quote
text so an edit lands, and what to do when an edit fails. It says nothing about any one
kind of work, so the Recipe's own skills decide how changes should read.

**With `legal-redlining-en-US`** — contract redlines, and responses to the other side's
redline.

```json
{
  "pi": {
    "documents": [{ "format": "docx", "profile": "legal-redlining-en-US" }]
  }
}
```

The agent also gets `profiles/legal-redlining-en-us/SKILL.md`, which covers:

- planning a first markup by what moves a right, an obligation or a risk;
- making the changes in `revise` batches, one rationale comment per change;
- removing a clause with `remove_section`, leaving `Reserved.` so numbering still lines up;
- answering the other side's changes with counters and replies, so the discussion stays
  visible, rather than accepting or rejecting;
- writing each rationale as the reason, in your side's voice, never narrating the edit.

The profile is generic legal practice. A firm's own positions, playbook and comment
style belong in the Recipe's skills, beside it.

**Your own profile** — for another kind of work with its own way of using the tool,
write a profile in the Recipe: a folder holding a `SKILL.md` whose frontmatter `name` is
the folder's name, and point `profile` at it.

```json
{
  "pi": {
    "documents": [
      { "format": "docx", "profile": "./profiles/house-style-en-gb" }
    ]
  }
}
```

[Write your own profile](../../../docs/documents/README.md#write-your-own-profile) has the
contract, what a profile should say, and a complete example.

## Python

The helpers in `python/` run in the shared environment every Word and PDF format shares:
Recipes' own `python/shared` project, locked once in Recipes, with paper-docx. The host
prepares it with uv when a Recipe uses this format and passes its interpreter to the
adapter. A Recipe declares no Python for this format. The module declares
document format `apiVersion` 2, so a Recipes host too old to prepare that environment
refuses to load it.

The interpreter is the first of:

1. `RECIPE_DOCUMENTS_PYTHON`, an explicit override;
2. the shared environment's interpreter, from the host;
3. `VIRTUAL_ENV` (`bin/python`, or `Scripts\python.exe` on Windows), for a host that
   prepares no shared environment;
4. `python3` on `PATH`.

Licences: the anchoring and section removal follow RedlineBench's redline engine (MIT,
Crosby Legal), see `python/recipe_documents_docx/LICENSE-redline-bench`. The rest is Apache-2.0.
