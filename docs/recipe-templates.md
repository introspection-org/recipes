# Recipe templates

A template repository declares ordered variables in `template.yaml` and keeps
its generated files under `template/`. Without `template.yaml`, the whole
repository is the payload, even if it contains a directory named `template/`. Only files ending in `.tmpl` have their
contents rendered; the suffix is removed. Paths are rendered too. Other content
is passed through as supplied by the snapshot host.

`{{ name }}` inserts a value as raw text. For YAML or JSON values, use an explicit
encoding without surrounding quotes:

```yaml
name: {{ name | yaml }}
```

```json
{"name": {{ name | json }}}
```

Both encodings serialize the typed value as JSON, which is also valid YAML.
Strings are quoted and escaped; booleans and integers retain their types. These
are serialization options, not an expression language. Unknown variables and
encodings fail rendering, and inserted values are never rendered again.

A variable's `when` must refer to an earlier boolean variable. A false condition
suppresses the requirement for a supplied value; it does not remove the binding.
Defaults still apply, otherwise inactive values render as empty strings, false,
or zero according to their type.

Generated paths must be nonempty relative paths using `/`, with no parent or
current-directory components, drive prefixes, backslashes, control characters,
or `.git` components. Windows device names, trailing dots/spaces, and
Windows-invalid filename characters are rejected on every host. Duplicate files and file/directory conflicts, including
implicit parent directories, are rejected before returning a snapshot.

`ensure_identity` validates the Runtime slug and parses YAML and JSON before
updating identity. It decodes the manifest's package path as YAML. Documents
whose identity already matches are preserved; modified identity documents are
reserialized and may lose comments or change formatting. Invalid or unread
identity documents fail rather than silently skipping the update.

The Python directory loader excludes symlinks, `.git` files, and dependency/build
directories at every depth. It rejects UNC/device paths and remote `file://`
hosts before probing the filesystem. On Windows, local drive URLs such as
`file:///C:/templates/x` are converted to native drive paths. Files that cannot be read as UTF-8 remain
unread entries; a host needing binary payloads must preserve their bytes itself.
