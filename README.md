# dsh-model-router

**English** · [简体中文](README.zh.md)

A routing plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that assigns models **by task**:
a delegated subagent runs on the model that **fits its job**, while the session you are talking to always keeps the model you picked.

## The Problem It Solves

A session has only one model, but a single conversation often carries **work of completely different kinds**: 3D modeling, web verification, merging a few paragraphs.
Doing everything with the same model is either expensive, or slow, or simply the wrong fit.

This plugin does exactly one thing: **when the main agent delegates a task to a subagent, pick the model by the kind of that task**. It leaves the main conversation alone — that is a hard constraint:

| Session | What This Plugin Does |
| --- | --- |
| The main session you are talking to | **Untouched**: the model, the tool table, and the context all stay as they are |
| The delegated subagent | Picks one from the model pool by task (global weighted rotation, not sharded per session) |
| The subagent delegating further down | Decided by `childDelegation`: when off (the default), any further delegation is rejected by the service layer's depth guard |

## Features

- **Zero preset changes**: at **runtime** the plugin registers its own `subagent` / `subagent_message` into the
  agent scope of an authorized preset, and masks the built-in delegation tool in that same scope. Revoking the
  authorization = destroying the fiber, the preset returns to its original state, and
  **no preset file was ever rewritten**.
- **One subagent sees the task through**: it is still alive after delivery, so follow-up feedback goes back to the
  **same** subagent through `subagent_message` instead of opening another one — task ownership stays unambiguous.
- **Configuration is files**: `global.yml` plus one file per task under `$DSH_HOME/model-routing/`. Editing by hand,
  by script, or from the settings page all touch the same files, taking effect within about a second.
- **Determinism first**: an explicit `[task: id]` → keywords → semantic classifier → default task → keep the
  inherited model. When one of the first two levels hits, **not a single model call is spent**; the verdict is
  **fixed for the whole round**, and a retry only moves to another candidate in the pool instead of re-asking the classifier.
- **Graded degradation**: next candidate in the pool → a quota-class failure skips the whole provider → an exhausted
  pool falls back to the default task → if none of that works, the plugin **stops rewriting the route** and hands the
  round back to the caller. Retries have a hard budget, so no unexpected failure can retry forever.
- **Breakage is visible**: the settings page status card shows the configuration source, the capability probe, the
  latest error, and whether the plugin has auto-disabled itself. Only failures on the **request path** count toward
  the circuit breaker (five in a row removes it automatically, retrying after 60 seconds); **degradations** such as a
  guard that cannot be installed or a failed query are still shown, but never take the routing down.
- **Bilingual UI**: settings-page copy follows the DSH language (Chinese / English), the same as built-in plugins.

## Installation

```bash
git clone https://github.com/IQzhan/deepseek-harness-model-router.git
cd deepseek-harness-model-router
node build-router.mjs
```

`build-router.mjs` does three things: build `package/`, link it into the profile's `node_modules`, and link the
bundled **skill** into `$DSH_HOME/skills/`. When something is missing it **degrades in order and says so**, without aborting:

| Missing | Behavior | Impact |
| --- | --- | --- |
| `@deepseek-ai/schemastery` / `cosmokit` (not there yet on a new machine) | Skips the inline step | The **fallback** for the settings namespace is unavailable and recorded as a degradation; the configuration-file path is unaffected |
| `yaml` | Skips the link | The runtime needs it to parse the configuration: run `npm i` in that package directory, or use `dsh plugin add` (which installs the dependencies) |
| no `cordis.patch.yml` in the profile | Skips the profile link | Add the line below yourself |

After adding one line to `$DSH_HOME/profiles/web/cordis.patch.yml`, **restart `dsh web`**:

```yaml
- insert:
    - id: dsh-model-router
      name: dsh-model-router
```

The equivalent one-liner: `dsh plugin --profile web add ./package`. After the restart, open **Settings → Task Routing**,
tick at least one authorized preset and turn on the master switch, and it is live. **The plugin ships fully off** and
changes no existing behavior just by being installed.

## Update / Uninstall

```bash
git pull && node build-router.mjs      # update; restart dsh web to take effect (the Host half needs a restart)
```

Uninstall: delete that line from the profile patch (or `dsh plugin --profile web remove dsh-model-router`), and delete
the `$DSH_HOME/profiles/web/node_modules/dsh-model-router` link; keep the configuration if you want it
(`$DSH_HOME/model-routing/`). **Uninstalling restores no preset**, because installing never changed one.

## Configuration

```
$DSH_HOME/model-routing/
  global.yml            master switch, default task, whether subagents may delegate further, classifier, preset authorization
  tasks/<task id>.yml   one task: display name, description, keywords, model pool, subagent persona and tool limits
```

The full field table is in [`skills/model-routing/SKILL.md`](skills/model-routing/SKILL.md): `enabled`, `defaultTaskId`,
`childDelegation`, the `enabled`/`provider`/`model`/`maxInputTokens`/`timeoutMs` of `classifier`, the `presets`
authorization, and per task the `name`/`description`/`enabled`/`keywords`/`pool` (including `weight`)/
`reasoningEffort`/`childPersona`/`childTools`. It doubles as the configuration manual for agents; the design
trade-offs and the pitfalls we hit are in [`docs/design-notes.md`](docs/design-notes.md); the item-by-item
verification ledger is in [`docs/verification.md`](docs/verification.md).

**Let the agent edit the configuration for you**: type `/model-routing` to invoke the skill installed with the plugin.
It only loads when you call it yourself and does not enter the model catalog (`disable-model-invocation: true`), so it
costs no everyday context.

## How It Works (In One Sentence)

When it assembles a request, DSH runs an `agent/request` waterfall, and that is where the plugin **rewrites the
provider/model this round will use** — before `llm.prepareCall()` and before `request/header` is recorded. Only a
child session is rewritten; the main session passes through untouched.

## Directory Structure

| File | Purpose |
| --- | --- |
| `model-routing-config.js` | Pure policy core: validation, decision ladder, scheduler (testable without Cordis) |
| `model-routing-store.js` | Configuration file I/O: atomic writes, per-file fault tolerance, migration from `settings.yaml` |
| `dsh-model-router.host.js` | Cordis adapter layer: routing seam, delegation tool, depth guard, health endpoint |
| `dsh-model-router.client.js` | Settings page (registered into `settings.section`, copy in Chinese and English) |
| `skills/model-routing/SKILL.md` | Configuration skill that only `/` can invoke |
| `docs/design-notes.md` | Design notes: why it is built this way, the pitfalls, the measured evidence |
| `docs/verification.md` | Per-feature × test-evidence ledger (including what is verified offline only, and why) |
| `build-router.mjs` | Build + Install (package, yaml dependency, skill) |
| `verify.ps1` / `verify.mjs` | Rebuild + run the whole offline suite (PowerShell / any platform) |
| `verify-live.ps1` | Accepts the **running** deployment: reads the health endpoint and judges PASS/FAIL item by item (read-only, spends no tokens) |
| `session-peek.mjs` | Reads one session log (zstd concatenated frames) to prove "which model this round actually ran on" |

## Testing

```bash
node verify.mjs          # or pwsh -File verify.ps1: rebuild + run the whole offline suite
```

**Tests never rewrite the real configuration**: the wiring suite only **reads** the deployment directory, and every
case that writes runs against a **temporary copy** of that same directory; the last assertion is "after this suite
ran, the live revision has not moved". The temporary directory lives in the repository's `.tmp/` (it does not write
to the system temp directory and does not touch the C: drive) and is cleaned up when the run finishes.

The suites: policy core · configuration files (real filesystem) · adapter layer (routing seam / delegation tool /
health endpoint) · wiring (build artifacts read the real configuration directory) · package (two real loaders + skill
contract) · settings page (real React rendering) · **bilingual documentation sync** · **portability guard** (no
absolute paths, no platform-specific constructs) · this machine's real configuration.

## Known Limitations

- **A child session still sees one delegation tool**: a child session runs a copy of the parent preset, and that copy
  installs the built-in delegation tool into the child session's **own scope**, which cannot be masked from outside
  (`restrict` reports an unknown tool, and naming it disables the whole filter). So the guarantee takes the form
  "**usable but always rejected**": any further delegation attempt is rejected by the service layer's depth guard
  (with an explicit error message).
- **A child session has no preset of its own**: DSH's delegation path has no "which preset does the child session
  use" parameter. Task-level `childPersona` and `childTools` get you the specialization instead, without requiring
  you to build a preset for every task.
- **The classifier is an LLM**: a borderline prompt may be judged differently twice; what the plugin guarantees is
  that it **will not ask again within the round**, and will not switch tasks halfway.
- **Model availability depends on your account**: when every model in a task's pool is unavailable (quota/balance),
  the round cascades to the default task; only if the default task is unavailable too does it go back to the caller.

## License

[MIT](LICENSE)
