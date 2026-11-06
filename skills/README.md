# Skills

**Audience: agents.** Each folder here is a skill the Recipes host offers to
the model in a running Recipe when an agent selects the tool it belongs to,
for example `documents/` when an agent selects `documents`. A skill tells the
model how to use a tool well. It ships in the npm package because the host
reads it at run time.

A format or provider package ships guidance for one kind of work as a profile
in its own package (`packages/documents/docx/profiles/`), not here.

Developers building a Recipe or a host read [the docs](../docs/) instead.
