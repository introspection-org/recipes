# Subagent Run Retention And Continuity

**Status:** §1-§3 implemented, both in the default in-memory controller
(`src/run-controller.ts`) and the persistence-backed one (`src/pi-extension.ts`),
with conformance tests on both. §4 turned out unnecessary — see its section
below — and is dropped rather than built. Extends the `agent` delegation
tool described in [`agent-composition.md`](./agent-composition.md) and the
`AgentRunController` contract every host implements.

One deviation found during implementation, beyond scope as originally
written: `pi-extension.ts`'s own `rehydrateChildRuns` already had full
`ChildAgentRunStore`-backed persistence and rehydration wired up — §2's
"wire up `ChildAgentRunStore`" was only true of the SDK's simpler in-memory
default controller, not of the actual host extension. What §2 became there
instead: closing the same crash-path notification gap §2 in the
`introspection-cloud` companion doc describes, since `pi-extension.ts`'s
`rehydrateChildRuns` had the identical gap — a run rehydrated as
`interrupted` never produced a completion notice, unlike a normal failure.

## Context

Comparing this package's subagent model against Arcee's `nac` harness
(`github.com/arcee-ai/nac`) and its "thread and episode" pattern — a named,
persistent worker identity a caller dispatches to repeatedly, where each
dispatch produces a structured summary retained only if the dispatch
actually succeeded — surfaced two gaps in our own `AgentRunController`
contract that are worth closing here rather than per-host:

1. **No retention rule.** Nothing in the contract says whether a failed or
   interrupted run's output is eligible to be reused as context for a later
   dispatch. Today it's simply never reused, because nothing reuses *any*
   prior run's output — see (2).
2. **No continuity.** Every `start()` call mints an unrelated run, even for
   the same named agent role in the same conversation. There's no way for a
   recipe author to say "let this role's next dispatch pick up where its
   last one left off."

A third piece — `ChildAgentRunStore` (`src/child-agent-store.ts`) — already
exists, with a full doc comment describing rehydration semantics, but is
never imported anywhere. It's dead code implementing exactly the persistence
primitive this proposal needs.

This is scoped to identity/context-hygiene behavior that belongs in the
portable contract, not to anything host-specific: process isolation,
telemetry backends, and crash-recovery notification policy are legitimately
per-host concerns (see each host's own operational docs) and are out of
scope here.

## Goals

1. Give the `AgentRunController` contract an explicit retention rule: a
   run's output is eligible to be reused as another dispatch's leading
   context only when that run's terminal status is `"completed"`.
2. Wire up `ChildAgentRunStore` in the default `createInProcessRunController`
   so local/offline `pi --recipe` sessions get durable per-run artifacts and
   rehydration, not just hosts that build their own persistence layer.
3. Add an opt-in `continue` flag to the `agent` tool's `start` action so a
   recipe author can let one named role's dispatches build on each other
   across a conversation, without changing the default (independent-run)
   behavior for every existing recipe.
4. Add a portable extension point for a host to attach run-hierarchy
   metadata (parent/root run id) to a child run, so a host that already
   tracks this (ours does, over OTel baggage) can surface it without this
   package needing to know anything about how.
5. A conformance-suite-based way to verify all of the above holds across
   every host, before and after — see Evaluation Plan.

## Non-goals

- Process isolation. This package already documents that skill/subagent
  selection is prompt exposure, not a security boundary — sandboxing is a
  host concern (`agent-composition.md` § Resources and Capabilities).
- Cross-thread composition backed by a telemetry read (nac's `threads:
  [...]` parameter). This package must keep working fully offline; a design
  that only works when a host's telemetry backend is configured belongs at
  the host layer, not here.
- Free-form thread naming independent of the declared agent role. `name`
  stays the role name declared in `agents/*.yaml`; this proposal makes that
  identity *continuable*, not renameable per call.
- Anything about how a specific host detects or recovers from its own
  process crashing mid-dispatch. `ChildAgentRunStore`'s rehydration already
  covers "a run persisted as running when the process restarted becomes
  read-only interrupted" — what a host does to *notify* about that (or not)
  is the host's own concern.

## Design

### 1. Retention rule on the contract

Document, in `AgentRunController`'s own interface comment (`src/agents.ts`),
that a run's `output` is eligible as prior context for a later dispatch only
when `status === "completed"`. This isn't yet enforced anywhere because
nothing reuses run output today (see §3) — landing the rule as a documented
contract obligation now means every host implementation, including a
third-party one, is answerable to the same behavior once §3 lands.

### 2. Wire up `ChildAgentRunStore` in the default controller

`createInProcessRunController` (`src/run-controller.ts`) keeps every `runs`
entry in a plain in-memory `Map` with no persistence at all — a fresh `pi`
process has no memory of prior runs in this workspace. `ChildAgentRunStore`
already implements exactly the artifact shape needed
(`.pi/agents/<runId>/status.json`, rehydration with a `"running"` →
`"interrupted"` flip on read) but is dead code.

Wire it in:

- `createInProcessRunController` takes an optional `store?: ChildAgentRunStore`
  (constructed from `workspaceDir` when omitted, matching
  `RecipeChildAgentSessionRunner`'s existing `workspaceDir` option).
- `touch()` calls `store.writeStatus(...)` alongside its existing `onUpdate`
  call.
- A new `rehydrate()` method reads `store.readPersistedSnapshots()`,
  flips any `"running"` entries to `"interrupted"` (mirroring the doc
  comment already on `ChildAgentRunStore`), and holds them read-only —
  `get`/`list` can see them, `message`/`interrupt`/`close` reject them by
  id, matching the shape `docs/agent-composition.md`'s delegation-is-one-
  level-deep model already expects from a controller.
- A host wanting different persistence (a database instead of the
  filesystem, a different crash-notification policy) still injects its own
  `AgentRunController` entirely, as today — this only changes what the
  *default* one does.

### 3. `continue` on the `agent` tool

```ts
// AgentToolParams (agents.ts), start action only
continue: Type.Optional(Type.Boolean())
```

`start({ name, prompt, continue: true })` resolves the most recent
`status === "completed"` run for that `name` (via the retention rule in §1)
and, when found, prepends its `output` as a `<prior_episode>` block ahead of
`prompt` before the child session is created. No prior completed run (first
call, or every prior call for that role failed) behaves identically to
`continue` omitted. `continue` defaults to `false`/omitted, so every
existing recipe's `agent` tool behavior is unchanged unless a recipe author
opts in.

This does not change session-per-run semantics — it changes what enters the
new session's *first* prompt. It does not touch `message()`, which already
continues one specific run's own session.

Update `docs/agent-composition.md` § Root Agents and Subagents with a short
note once this lands, since that section is the normative description of
delegation today.

### 4. Portable run-hierarchy metadata hook — dropped, not built

Originally proposed: extend `AgentMeta { conversationId, agentId, agentName }`
with optional `runId` / `runParentId` / `runRootId` so a host could attach
its own run hierarchy without this package knowing anything about how.

This is unnecessary. `@introspection-sdk/introspection-pi`'s
`instrumentAgent`/`instrumentSession` already accept an `extraAttributes`
hook — arbitrary attributes a host layers onto every span, not fixed to
three named fields. Our own `runtime-agent` already uses exactly this to
attach `introspection.run.id` / `.run.parent_id` / `.run.root_id` (see the
`introspection-cloud` companion doc's Context section). Widening `AgentMeta`
would have been a narrower, redundant path to something the existing hook
already does more generally. No change needed here.

## Evaluation plan

Two different questions need two different kinds of verification.

### Behavioral correctness — deterministic, host-agnostic, no model calls

Extend the existing host-conformance suite (`src/test-utils.ts`'s
`hostConformanceCases`) — this is exactly the mechanism built for "prove a
host's `AgentRunController` didn't drift," and every host (ours included)
already runs it in its own CI. New cases, each a deterministic `{name, run}`
pair against a scripted/mock model (`test/helpers/mock-extension.ts`), no
real model call:

- A failed run's output is never returned as `continue`'s prior-episode
  source, even when it's the most recent run for that role.
- Two concurrent `start()` calls for the same role produce two runs whose
  outputs don't cross-contaminate each other's eventual `continue` lookup.
- A rehydrated (`"running"` → `"interrupted"`) run is readable via
  `get`/`list` but rejects `message`/`interrupt`/`close`.
- `continue: true` with no prior completed run behaves byte-identical to
  `continue` omitted.
- `continue: true` with a prior completed run prepends exactly one
  `<prior_episode>` block, once, not on every subsequent turn of the new
  run.

This is the right tool for "did we regress the mechanism" and runs in CI on
every PR to this package and to any host that adopts the new conformance
cases — no separate infrastructure to build.

### Delegation quality — judged, needs a real dataset

Whether these changes make a *multi-agent, multi-turn* conversation actually
better — not just mechanically correct — needs LLM-judged evaluation against
real scenarios, using the existing recipe-judge contract this repo already
owns (`docs/recipe-judges.md`) and the calibration workflow described in
`introspection-cloud`'s `judges-and-evaluation.md` (labelled JSONL fixtures +
`judges eval`, owned by the `introspection-judge-engine` the CLI packages —
that execution half is out of this repo's ownership boundary per
`recipe-judges.md`'s own split).

Proposed shape, to build as a follow-on once this design is signed off (not
in this PR):

- A small fixture recipe with 3 roles: a coordinator and two named
  specialists, one of which is scripted to fail on its first dispatch in
  some scenarios (to exercise retention) and to be re-dispatched later (to
  exercise `continue`).
- A labelled scenario set (JSONL, per the calibration workflow's existing
  shape) covering: (a) sequential delegation where a later dispatch to the
  same role should benefit from `continue`; (b) concurrent same-role
  dispatches that must stay isolated; (c) a scripted failure followed by a
  retry, verifying the failed attempt never leaks into the retry's context;
  (d) a long conversation exercising several rounds of delegation, checking
  the coordinator's final answer correctly reflects every specialist's
  *latest* contribution rather than a stale or duplicated one.
- Judge dimensions scored per scenario: **delegation correctness** (did the
  coordinator's final answer use the right specialist's actual output),
  **context isolation** (any sign of cross-contamination between concurrent
  or sequential same-role runs), and **continuity value** (for the
  `continue`-eligible scenarios, did the specialist visibly build on its own
  prior output rather than re-deriving it).
- Run the fixed scenario set against the recipe before this change (`main`)
  and after (this branch), same scenarios, same judge, and diff verdicts —
  the calibration workflow already supports exactly this before/after
  comparison shape.

This half is flagged as a proposal, not a commitment in this PR, because it
depends on tooling (`judges eval`) that lives outside this repository's
ownership boundary and should be scoped with whoever owns that workflow.

## Rollout

1. ~~§1 (documentation-only) and §2 (`ChildAgentRunStore` wiring) can land
   together — no wire-contract change, additive to the default controller.~~
   Landed together: the retention-rule doc comment, `pi-extension.ts`'s
   crash-path notification fix, and deterministic tests for both.
2. ~~§4 (portable metadata hook) lands alongside or after §2.~~ Dropped —
   see §4 above.
3. ~~§3 (`continue` flag) lands last.~~ Landed in the same PR as §1/§2 rather
   than separately: implementing all three together surfaced the §2
   deviation (above) that would have been easy to miss doing them apart,
   and every consuming host still needs its own coordinated release to
   actually expose `continue` to a recipe author, which this PR does not
   do on its own.
4. The deterministic conformance cases landed with the section they verify:
   `test/child-agent-completions.test.ts` for the crash-path notice,
   `test/pi-extension-continue.test.ts` and `test/session.test.ts`'s
   `continue` describe block for retention + continuation, on both
   controller implementations.
5. The judged evaluation dataset is still scoped and built separately, once
   this design is signed off, against whichever repo owns `judges eval`.
