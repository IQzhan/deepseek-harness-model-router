# dsh-model-router

Task-aware model routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
delegated subagents run on the model that fits THEIR task, while the conversation you are
in keeps the model you picked.

- **Your session is never touched.** The composer's model IS the main model. Routing applies to
  delegated child sessions only.
- **One plugin, two tools.** It supplies `subagent` (delegate one closed task) and
  `subagent_message` (send revisions back to the SAME child) — so a preset needs no delegation
  row of its own, and the built-in delegation tools are masked at runtime.
- **No preset is ever edited.** The tools are registered per agent scope at runtime; revoking a
  grant disposes them and the deployment is exactly as it was.
- **Configuration is files**, one folder beside `settings.yaml`, one file per task.
- **A task can shape its children**: a task-specific persona that replaces the inherited one, and
  a tool subset — both optional, both per task.

## Install

```bash
git clone <this repo> && cd dsh-model-router
node build-router.mjs          # builds package/, links it into the profile, installs the skill
```

Then add the row to your profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`) and restart:

```yaml
- insert:
    - id: dsh-model-router
      name: dsh-model-router
```

Equivalent, without editing files by hand:

```bash
dsh plugin --profile web add ./package
```

Rebuild + restart is the whole update cycle. **Uninstall** = remove that row (or
`dsh plugin --profile web remove dsh-model-router`), delete the link under
`$DSH_HOME/profiles/web/node_modules/`, and — if you want the configuration gone too —
delete `$DSH_HOME/model-routing/`. Uninstalling touches no agent preset.

## Configuration

```
$DSH_HOME/model-routing/
  global.yml            enabled / defaultTaskId / childDelegation / classifier / preset grants
  tasks/<task id>.yml   one task: name, description, keywords, pool, and its child profile
```

Edit them by hand (they take effect within a second) or through **Settings → 任务路由**.
The settings page edits the same files; its save bar commits a whole draft atomically and refuses
to overwrite a change made elsewhere.

The plugin ships a skill that teaches an agent to edit this configuration correctly. It is
**not** discoverable by the model — invoke it explicitly with `/model-routing` when you want an
agent to add, change or remove a task for you.

## How a route is chosen

1. `[task: <id>]` in the message → that task
2. a task keyword appears in the recent text → that task
3. otherwise, once per turn, a cheap classifier model picks the task from the descriptions
4. otherwise `defaultTaskId`
5. otherwise the child keeps the model it inherited

Within a task, models rotate by weight **globally** (all sessions share one rotation) and stay
pinned for the whole turn. On failure: next model in the pool → the default task → stop rewriting
and let the caller carry on.

## Layout

| Path | What it is |
| --- | --- |
| `model-routing-config.js` | The policy: validation, the tier ladder, weighted rotation, classifier I/O. Pure, no Cordis, no I/O. |
| `model-routing-store.js` | The configuration files: read/write, atomic replace, per-file errors, migration. |
| `dsh-model-router.host.js` | The Cordis adapter: routing seam, delegation tools, health endpoint, config endpoints. |
| `dsh-model-router.client.js` | The settings page (a client bundle registered into `settings.section`). |
| `skills/model-routing/SKILL.md` | The `/`-only skill for editing the configuration. |
| `build-router.mjs` | Builds `package/`, links it into the profile, installs the skill. |

## Tests

```bash
node test-model-routing-config.mjs   # the policy
node test-store.mjs                  # the configuration files, against a real filesystem
node test-router-host.mjs            # the adapter, through the generated artifact
node test-store-wiring.mjs           # the artifact reading the real folder
node test-package.mjs                # both real loaders
node test-render.mjs                 # the settings page, through React
node test-deployed-config.mjs        # this machine's actual configuration
```

`test-live-nondeepseek.mjs` additionally makes REAL network calls to whatever providers the
deployment has configured, and skips hosts it cannot reach.
