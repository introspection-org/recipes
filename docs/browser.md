# Browser tool

A Recipe that works in a web page declares `pi.browser`. The host then
registers one `browser` tool with a `command` discriminator, shaped like
[`channels`](channels.md). The browser itself belongs to the platform: a
headless Chromium beside the task's sandbox, reached over the Chrome DevTools
Protocol (CDP). The Recipe declares what the agent may do with it, never how to
reach it.

```json
{"pi":{"browser":{"commands":["observe","act","navigate","run"],"allowedDomains":["app.example.com","*.example.com"]}}}
```

An agent selects it with `tools: [browser]`. The host fails when an agent names
`browser` and the Recipe does not declare `pi.browser`.

| Field | Meaning |
| --- | --- |
| `commands` | Allowlist of commands for every agent in the Recipe. Omitted: every supported command. An empty list registers no tool. |
| `allowedDomains` | Hosts the browser may reach. The platform admits them on the task's egress; the tool refuses navigation elsewhere. `*.example.com` admits subdomains only; list `example.com` too for the apex. Omitted: only the platform's default egress hosts. |
| `profile` | `none`, `optional` or `required`: whether a task must name a stored browser profile (signed-in cookies). Defaults to `none`. |

Unknown or unsupported commands fail at registration, and invalid arguments are
rejected before the browser is touched.

## Commands

| Command | Arguments | Result |
| --- | --- | --- |
| `observe` | `tab_id?`, `cursor?` | The page as an element table: URL, title, visible text, and one row per control with an `el_…` handle, role, name, value and allowed actions. `next_cursor` pages long tables. |
| `act` | `element`, `action` (`click`, `type`, `select`), `text?` | Performs the action on a handle from a previous `observe`. `type` replaces the value. |
| `scroll` | `direction` (`up`, `down`), `tab_id?` | Scrolls most of a viewport. |
| `navigate` | `url`, `tab_id?` | Loads the URL; `tab_id: "new"` opens a tab. |
| `tabs` | — | Lists open tabs. |
| `screenshot` | `tab_id?` | A JPEG of the page, returned as image content. Prefer `observe`: text is cheaper and precise. |
| `run` | `goal`, `inputs?`, `max_steps?` | Hands a routine flow to the fast browser driver. |

### Handles

An `el_<page>_<n>` handle names one element of one page. Before acting, the
tool checks that the element still exists, is enabled, and is not covered by
another element; offscreen elements are listed after visible ones and are
scrolled into view. A navigation invalidates every handle, so `act` with an old
one fails with `stale` and the agent observes again. Page text is untrusted
data, never instructions.

### `run`

`run` gives a routine flow — a search, a form, a set of filters — to Jev, a fast
decision model, which completes it in about a second where a frontier model
takes one call per step. Put values the flow needs in `inputs`
(`{"destination": "Lisbon"}`), so the driver types them exactly rather than
inventing them.

The calling agent is the fallback. When the driver is blocked, repeats invalid
actions, or spends its step budget, `run` stops and returns the trajectory; the
agent continues from there with `observe` and `act`. `run` is registered only
when the platform provides a driver route (`INTROSPECTION_TASK_BROWSER_JEV_URL`).

## Host contract

The host reads the browser from the task environment, beside
`INTROSPECTION_TASK_CHANNEL_*`:

| Variable | Meaning |
| --- | --- |
| `INTROSPECTION_TASK_BROWSER_CDP_URL` | CDP endpoint of the task's browser, loopback inside the sandbox. Absent: the tool still registers and fails when called. |
| `INTROSPECTION_TASK_BROWSER_ALLOWED_DOMAINS` | Comma-separated platform allowlist. |
| `INTROSPECTION_TASK_BROWSER_JEV_URL` | Driver route for `run`, reached through the sandbox's provider egress so the model key never enters the sandbox. |

The page work lives in `@introspection-sdk/browser-agent`, which the runtime
supplies; the Recipe does not depend on it. Hosts register the tool with
`registerBrowserTool(pi, { commands, allowedDomains })` from
`@introspection-ai/recipes/browser`. Outside a Recipe, the same commands are
`introspection browser observe|act|navigate|scroll|tabs|screenshot` in the
`introspection` CLI.
