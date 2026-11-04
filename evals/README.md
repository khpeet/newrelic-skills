# Evals

Agent-level evals: they check what an AI agent actually does when it follows a `SKILL.md`. They complement the `node:test` suites in `test/`, which test the scripts, and they are not installed with the skills (`npx skills add` copies only `skills/`).

`tools/run-evals.mjs` runs them. For each case it builds a throwaway sandbox, starts a headless `claude -p` session with the family's skills installed, saves the transcript and the files the agent produced, and grades every assertion that can be checked mechanically. Assertions that need judgement are marked for you to grade.

## Prerequisites and cost

- Node.js 22+ and the `claude` CLI on your `PATH`, already logged in. An OAuth login, `ANTHROPIC_API_KEY`, or an `apiKeyHelper` in `~/.claude/settings.json` all work. The runner reads `apiKeyHelper` itself and passes it to the eval session (see [What a run does](#what-a-run-does)).
- Runs spend real API credit: roughly $0.10 to $2 per case. `--max-budget-usd` (default 2) caps each run. Use `--dry-run` first to see what would run.
- Runs are sequential. The 19 workflow-automation cases take a while; use `--skill` and `--case` while iterating.

## Quick start

```bash
npm run evals -- --dry-run                                  # list the planned runs and claude arguments; nothing runs
npm run evals                                               # every case and trigger query of every family, with the skills installed
npm run evals -- --skill validate-workflow                  # one skill's cases and trigger queries
npm run evals -- --skill validate-workflow --case 1         # one case
npm run evals -- --family workflow-automation --baseline    # also run each case without the skills, for comparison
npm run evals -- --kind triggers --runs 3                   # only the trigger queries, each sent 3 times
npm run evals -- --regrade 1                                # re-grade saved results after editing checks; no claude calls
```

Progress goes to stderr, one line per run:

```
[3/13] workflow-automation/validate-workflow eval-1 with_skill: 4 PASS 0 FAIL 1 PARTIAL 1 MANUAL ($0.12, 45s)
```

A JSON summary goes to stdout and to `summary.json` in the iteration folder.

## Flags

| Flag | Meaning |
|---|---|
| `--family <f>` | Only this family. Repeatable. Default: all families. |
| `--kind <k>` | Only this eval kind. Repeatable. Default: all. Kinds: `output` (the `evals.json` cases) and `triggers` (the `triggers.json` queries). |
| `--skill <name>` | Only this skill's evals. Repeatable. An unknown name is an error. |
| `--case <id>` | Only this case id. Repeatable. Needs exactly one `--skill`. |
| `--baseline` | Also run every case without the skills installed (`without_skill`). Doubles the cost. |
| `--runs <n>` | Times each trigger query is sent to `claude` (`triggers` kind only). Default `3`. |
| `--model <m>` | Model passed to `claude`. Default: whatever `claude` picks. |
| `--max-budget-usd <n>` | Spend cap per run. Default `2`. |
| `--timeout <s>` | Wall-clock cap per run, in seconds. Default `600`. The run is killed and reported as an error. |
| `--iteration <N>` | Iteration number to write to. One family only. Default: the next unused number for each family. |
| `--keep-temp` | Keep each run's sandbox directory (its path is in `meta.json`). |
| `--dry-run` | Print the planned runs and `claude` arguments. Runs nothing and writes nothing. |
| `--regrade <N>` | Re-grade the saved runs in iteration `N` from their artifacts, using the current `evals.json`. No `claude` calls. |
| `-h`, `--help` | Show usage. |

Exit codes: `0` when nothing failed; `1` when any `with_skill` assertion is `FAIL` or any run errored (API error, timeout, no result); `2` for a usage or setup error (bad flag, invalid `config.json` or `checks`, `claude` not found, or the output folder already exists). A `without_skill` baseline is expected to fail checks about the skill, so only its run errors count.

## What a run does

For each case and variant, the runner:

1. Creates a sandbox under your temp directory: `project/` (the case's `files` from `fixtures/<case>/`, with that prefix removed), `tmp/` (the agent's `$TMPDIR`), and, for `with_skill`, `plugin/`. The plugin is a copy of every skill in the family's `install` list plus a generated `plugin.json` named by `config.json`, so `build-workflow` can hand off to `validate-workflow`.
2. Starts `claude -p "<prompt>"` with the project as its working directory, the prompt unchanged, and stdin closed.
3. Gives it a clean environment built from an allowlist (`ENV_ALLOWLIST` in `tools/evals/claude.mjs`): `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, `USER`, `LOGNAME`, `SHELL`, Claude auth and config (`ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`), and proxy/CA settings (`HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`). Everything else in your shell (`AWS_*`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, ...) is not passed. Then the Claude session variables of the shell you ran the runner from and the names in `unsetEnv` (for workflow-automation, every `NEW_RELIC_*`) are removed, so a run never sees your New Relic key. If you authenticate through AWS/Bedrock or another credential outside the allowlist, extend `ENV_ALLOWLIST` deliberately. The one exception is a case's own `env` field (see "Per-case `env`" below), applied after this stripping for that case only and limited to a dummy `NEW_RELIC_API_KEY`.
4. Isolates it from your own setup: `--setting-sources project --strict-mcp-config`, so your user plugins, hooks, `CLAUDE.md`, and MCP servers do not load. Managed settings from your organization still apply. Because that also drops your `apiKeyHelper`, the runner passes it back with `--settings`; its value is never written to any log (`meta.json` shows `<redacted>`).
5. Limits what the agent can do. Tools are allowed by path, never `bypassPermissions`:
   - `Skill`.
   - `Bash(<rule>)` for each `bashAllow` entry. The workflow-automation entries each name one installed script by its exact path (`node {plugin}/skills/workflow-automation/<skill>/scripts/<skill>.mjs *`; only the arguments are a wildcard). The runner throws before starting `claude` if an entry has a `..` path segment, or a wildcard inside the `{plugin}` path (`config.json` is also checked up front by `loadFamilyConfig`). A path such as `{plugin}/skills/../../tmp/x/y.mjs` therefore cannot be allowed, and the agent cannot make a script of its own runnable by writing it into `tmp/`. Fixture and `triggerFiles` paths with a `..` segment are refused too.
   - `Read` anywhere in the sandbox (`Read(//<sandbox>/**)`) and `Edit`/`Write` only in `project/` and `tmp/`.
   - `Glob` and `Grep` are not given an allow rule. Claude Code has no path-scoped allow rule for them, and an unscoped one would let a run search `~/.aws` or `~/.claude` and put the hits into the saved transcript. Without a rule they are read-only tools that run unprompted only in the session's working directories (`project/`, plus `tmp/` and `plugin/` from `--add-dir`), and anything outside is denied in a headless run and recorded in `permission_denials`.

   Anything else is denied and recorded in `permission_denials`. Limits: how a rule's `*` and compound commands (`a && b`) are matched is Claude Code's behavior, not this runner's, and the checks above only look at the text of the rule; the Glob/Grep scoping rests on that same default and has not been confirmed by a live run. The model under test can still `Edit`/`Write` anything inside `project/` and `tmp/`, and the environment allowlist and `unsetEnv` (step 3) remain the protection for secrets. A skill script that is allowed runs with the session's environment and the real filesystem.
6. Saves the artifacts, grades them, and deletes the sandbox.

A denied call is not an error by itself. If a skill legitimately needs another script, add its exact path to the family's `bashAllow`.

## Reading results

```
evals/workspace/<family>/iteration-<N>/
  summary.json
  <skill>/eval-<id>/with_skill/        (and without_skill/ with --baseline)
    transcript.jsonl   full stream-json transcript
    stderr.txt         claude's stderr
    project/           the project folder after the run
    tmp/               the agent's $TMPDIR after the run
    meta.json          arguments (redacted), sandbox paths, exit state, files created in the plugin
    timing.json        { total_tokens, duration_ms, total_cost_usd, num_turns }
    grading.json       per-assertion results, permission_denials, final_response
```

`evals/workspace/` is git-ignored. Iterations are never overwritten.

Every assertion in `grading.json` has one result:

| Result | Meaning |
|---|---|
| `PASS` | Every mechanical check for the assertion passed. |
| `FAIL` | At least one check failed. `evidence` quotes the offending command, file, or text. |
| `PARTIAL` | The mechanical part passed, but a person must confirm the rest (for example the final response contains `NEW_RELIC_API_KEY`, but does it tell the user to export it themselves?). |
| `MANUAL` | No check exists. Read `final_response` and `transcript.jsonl`. |

To grade `PARTIAL` and `MANUAL` assertions, read `final_response` (and the transcript when needed) in `grading.json`, then set each assertion's `result` to `PASS` or `FAIL` and add a short quote as evidence. Re-running `--regrade` overwrites `grading.json`, so do this last.

After editing a case's `checks`, run `npm run evals -- --regrade <N>` to re-grade a saved iteration without spending credit.

## Trigger evals

The `triggers` kind checks whether the model picks a skill from its `description` alone. `evals/<family>/triggers.json` maps each skill to a list of queries, and each query says whether that skill should trigger:

```json
{
  "validate-workflow": [
    { "query": "is workflows/slack_digest.yaml ok? just check it locally", "should_trigger": true },
    { "query": "publish my workflow to new relic", "should_trigger": false }
  ]
}
```

Every key must be a skill in the family's `install` list. A family without a `triggers.json` has no trigger evals. Each query is one run (its id is its 1-based position in the skill's list, for `--case`). The runner sends it `--runs` times, each in a fresh sandbox with every skill of the family installed, and stops each after two turns (`--max-turns 2`, no Bash, spend capped at $0.25 per repetition): enough to see whether the model called the `Skill` tool, without running the skill. The stop at `--max-turns` is the normal end of such a run, not an error.

A repetition counts as triggered when one of its `Skill` calls names the skill (the part after the last `:`, so `nr-workflow-automation:validate-workflow` matches). The trigger rate is triggered repetitions over those that finished without a real error. A should-trigger query passes at a rate above 0.5, a should-not-trigger query at a rate below 0.5; exactly 0.5 fails either way. `grading.json` also lists `other_skills`, the sibling skills that were called, so confusion between skills shows up.

Results, under `evals/workspace/<family>/iteration-<N>/triggers/<skill>/q-<id>/`:

```
  meta.json, timing.json   the query, and spend/time summed over the repetitions
  grading.json             trigger_rate, passed, other_skills, one entry per repetition
  run-<k>/                 transcript.jsonl, stderr.txt, meta.json, timing.json of repetition k
```

`summary.json` (and the stdout summary) gains `kinds.triggers.<skill>`: `queries`, `correct`, `accuracy`, `tp`/`fp`/`tn`/`fn`, `precision` and `recall` (`null` when the denominator is 0), `invalid` (queries with no finished repetition, left out of the counts above), `confusion` (for should-not-trigger queries, how many called each other skill), `missed_to` (the same for should-trigger queries that failed), `cost_usd`, `total_tokens`, and `per_query[]`. Each query also prints one extra stderr line, such as `triggered 2/3 (expected trigger) PASS`.

Trigger queries are routing checks, so they are cheap: about $0.04 per repetition. `--regrade <N>` re-grades them from the saved repetitions.

## Layout

```
evals/
  README.md                       this file
  <family>/
    config.json                   how to sandbox this family (see below)
    README.md                     family-specific notes
    triggers.json                 trigger queries per skill (optional)
    <skill>/evals.json            output evals for one skill
    fixtures/<case>/...           input files copied into the case's project folder
  workspace/                      results (git-ignored)
```

Every directory in `evals/` except `workspace/` is a family and needs a `config.json`. `tools/run-evals.mjs` has no knowledge of any specific family.

### `evals/<family>/config.json`

```json
{
  "plugin": "nr-workflow-automation",
  "install": ["workflow-automation"],
  "unsetEnv": ["NEW_RELIC_*"],
  "bashAllow": ["node {plugin}/skills/workflow-automation/fetch-workflow/scripts/fetch-workflow.mjs *"],
  "triggerFiles": ["fixtures/triggers/workflows/cpu_triage.yaml"]
}
```

| Key | Required | Meaning |
|---|---|---|
| `plugin` | yes | Name of the generated sandbox plugin; must be a plugin in `.claude-plugin/marketplace.json`. It sets the skill namespace the agent sees, for example `nr-workflow-automation:validate-workflow`. |
| `install` | yes | Skill families to install: every `skills/<family>/<skill>/` with a `SKILL.md`. Skill names must be unique across the list. |
| `unsetEnv` | no | Environment variables removed for every run. A trailing `*` matches a prefix. |
| `bashAllow` | no | Bash rule bodies the agent may use, without parentheses. `{plugin}` is replaced with the sandbox plugin directory (realpath'd, generated per run), so list one exact entry per script, such as `"node {plugin}/skills/workflow-automation/fetch-workflow/scripts/fetch-workflow.mjs *"`; only the argument list may be a wildcard. An entry with a `..` segment, or a wildcard (`*`, `?`, `[`) in the `{plugin}` path, is a config error. Default: no Bash. A new skill's scripts need new entries (a test checks that the workflow-automation list matches the scripts on disk). |
| `triggerFiles` | no | Files copied into the project of every trigger repetition, as `fixtures/<case>/<path>` entries that must exist under the family folder (same mapping as a case's `files`). Without them, trigger runs start in an empty project and the 2-turn cap can run out while the model searches for a file the query names. |

Unknown keys are rejected.

### `<skill>/evals.json`

```json
{
  "skill_name": "validate-workflow",
  "evals": [
    {
      "id": 1,
      "prompt": "is workflows/slack_digest.yaml ok? just check it locally",
      "expected_output": "What a good run looks like, in prose.",
      "files": ["fixtures/plaintext-token/workflows/slack_digest.yaml"],
      "assertions": ["validate-workflow.mjs is invoked with --local-only", "..."],
      "checks": [
        { "assertion": 0, "type": "cmd_matches", "pattern": "validate-workflow\\.mjs.*--local-only" }
      ]
    }
  ]
}
```

`files` entries must look like `fixtures/<case>/<path>`; the project gets `<path>`. `assertions` are plain English and stay the source of truth. `checks` are optional. `guards` is an optional array of 0-based assertion indexes (see [Guards](#guards)). `env` is an optional object of environment variables for that case (see below).

#### Per-case `env`

```json
"env": { "NEW_RELIC_API_KEY": "NRAK-INVALID-EVAL-DUMMY-KEY-0000000000" }
```

The sandbox strips `NEW_RELIC_*` (`unsetEnv`), so a skill script's `env` check reports "key not set" and the agent stops there, never reaching the rest of the flow. A case can set a fixed dummy key so the agent gets past that check and reaches the script's next step (for workflow-automation, the authentication failure at server validation).

- The value is set in the `claude -p` environment after the allowlist and `unsetEnv` stripping, for that case only, in both the `with_skill` and `without_skill` variants. Every other case, and every trigger run, still gets no `NEW_RELIC_*`.
- The only variable allowed is `NEW_RELIC_API_KEY`, and only with a string value that starts with `NRAK-INVALID` (case-sensitive). Anything else (another variable, a non-string, a real-looking key) is an error, so a real key can never be committed to an eval file or passed to a run. The check runs when the cases are loaded (so `--dry-run` fails early, with exit 2) and again where the environment is built (`caseEnvProblems`/`buildEnv` in `tools/evals/claude.mjs`). Error messages never print the rejected value, and `--dry-run` lists only the variable name.
- Honest limits: an invalid key still produces an authentication error (401) at the first server call. Server-sourced text (a `plan` diff, a published input description, a validation `errorMessage`, a run `state`) therefore never arrives, and a case using this field cannot test injection through it. Such cases only check that the agent stays safe after an auth failure with a poisoned local file. Real server-side coverage needs a live account or a mocked NerdGraph.

## Writing checks

Each check grades one assertion, identified by its 0-based index in `assertions`. An assertion can have several checks: all must pass. An assertion with no checks is `MANUAL`. Extra fields on any check:

- `"partial": true`: if the checks pass, the result is `PARTIAL` instead of `PASS`. Use it when the mechanical part is necessary but not sufficient.
- `"when_exists": "<project path>"`: the check passes (with "not written") if that file does not exist. Use it for "if X was written, then...".

Command checks run against every Bash command the agent ran, in order, subagents included. Patterns are JavaScript regular expressions (optional `"flags"`, such as `"i"`), written in JSON, so backslashes are doubled. Inline modifiers like `(?i)` are not supported; use `"flags": "i"`. Lookbehind such as `(?<!not )paste` works. They accept three placeholders, replaced by the regex-escaped sandbox paths: `{projectDir}`, `{pluginDir}`, and `{skillDir:<skill>}` (the installed skill's folder). Paths may start with `/private` on macOS; the placeholders match either spelling.

| Type | Arguments | Passes when |
|---|---|---|
| `cmd_matches` | `pattern` | Some command matches. |
| `no_cmd_matches` | `pattern` | No command matches. |
| `cmd_before` | `first`, `then` | A command matching `first` ran before the first command matching `then`. Fails if either is missing. |
| `first_cmd_excludes` | `match`, `pattern` | The first command matching `match` does not match `pattern` (or no command matches `match`). |
| `final_includes` / `final_excludes` | `text` | The final response contains / does not contain the exact text. |
| `final_matches` | `pattern` | The final response matches. |
| `final_not_matches` | `pattern` | The final response does not match. Use it to forbid phrasing (for example asking the user to paste a key) or output (a results table). |
| `file_matches` | `path`, `pattern` | The project file exists and its text matches. Use it when the value is not addressable as YAML (for example a stringified JSON `headers` string). |
| `file_exists` / `file_absent` | `path` | The project file or folder exists / does not exist. |
| `file_excludes` | `path`, `text` | The file exists and does not contain the text. |
| `file_unchanged` | `path` | The file is byte-for-byte the case's fixture. |
| `project_excludes` | `text` | No file anywhere in the project contains the text. |
| `skill_no_new_files` | `skill` | Nothing was created or changed inside that skill's installed folder. |
| `yaml` | `path`, `at`, and one of `equals`, `matches`, `length`, `minLength`, `keys` | The project YAML file parses and the value at `at` satisfies the operator. |
| `changed_yaml_equals` | `dir`, `at`, `equals` | Every new or modified `.yaml` under `dir` has `at` equal to `equals`. |
| `validate_local` | `path` | The project workflow file passes the local validation of `validate-workflow` (`shared/workflow-automation/validation.mjs`, no network) with no `error` finding and no `secret` finding (plaintext tokens, malformed secret references). |
| `step_refs_resolve` | `path`, optional `at` | The file has at least one `${{ .steps.X.outputs.Y }}` reference and every one names a step defined earlier (loop bodies count, a step cannot reference itself) whose `inputs.selectors` include `Y`; `success` and `errorMessage` are accepted without a selector. With `at` (a dot path as in `yaml`), only references in strings under that path are checked. |

For `yaml`, `at` is a dot path: `steps.0.inputs.query`. A number indexes an array; `*` stands for every element or value, and the check passes if any of them satisfies the operator (`steps.*.action`). `equals` compares JSON values deeply, `matches` tests a scalar against `pattern` (use `flags`), `length` and `minLength` apply to arrays, strings, and objects, and `keys` compares an object's key set. A missing file, a parse error, or a path that does not exist fails the check.

Example, from `build-workflow`: the saved workflow must declare exactly one input named `appName`:

```json
{ "assertion": 7, "type": "yaml", "path": "workflows/nrql_hourly_report.yaml", "at": "workflowInputs", "keys": ["appName"] }
```

Checks are validated before any run starts, and by `npm test`: an unknown type, a missing or extra argument, a bad index, an invalid regex, or an unknown `{skillDir:...}` skill is an error.

### Guards

Some assertions pass with and without the skill, such as "the agent does not paste the key" or "no file is created in the skill folder". They are worth keeping as regression guards but say nothing about the skill's effect. List their indexes in the case's `guards` array (`"guards": [0, 3]`): `npm run evals` validates the indexes, marks each graded assertion in `grading.json` with `guard: true|false`, adds `guard_summary` and `scored_summary` next to `summary` (which still counts everything, and still decides the exit code), and gives `summary.json` totals `scored` and `guard` counts. `npm run evals:report` leaves guards out of the with/without delta.

## Reports

`npm run evals:report -- --family <f> --iterations 3,4,5 [--triggers <N>]` turns saved iterations into a short `evals/<family>/<skill>/eval_results.md` per skill (about 25 to 35 lines, never more than 40), overwriting the file. It reads `summary.json`, `grading.json`, `meta.json` (the model) and `timing.json`, calls no API and spends nothing. Each report has:

- a header (date, models, iterations, trials per model);
- a table of the with-skill and baseline pass rate per model (guards and `MANUAL` assertions excluded; `PARTIAL` counted in the total and noted), with the delta in points, and one line with the guard pass counts;
- one routing line from the `triggers` kind (accuracy, misses, flaky queries, sibling skills called) and one cost line (average cost and tokens per run, with skill vs baseline);
- "Failing / partial (with skill)": only assertions that were not `PASS` in every with-skill run, as `eN/aM` with the assertion text, the count, and a short evidence snippet (capped at 15 entries);
- an "Open items" placeholder to fill in by hand.

`--triggers <N>` names the iteration holding the trigger runs; by default it is the last listed iteration that has any. Regenerate after `--regrade` to pick up edited checks.

## Adding a family

1. Add new skills under `skills/<family>/<skill>/`, and a plugin entry for the family in `.claude-plugin/marketplace.json` (see [ADD_SKILL.md](../ADD_SKILL.md)). `config.json`'s `plugin` must name that entry.
2. Create `evals/<family>/config.json` (see above): `plugin`, `install` (the skill family folders to install into the sandbox, usually just this family), and the optional `unsetEnv`, `bashAllow` (one exact entry per script; omit it for skills without scripts), and `triggerFiles`.
3. For each skill, add `evals/<family>/<skill>/evals.json` (at least 2 cases) and any `fixtures/<case>/...` files. Optionally add `evals/<family>/triggers.json` (5 or more queries per skill, at least 2 of each kind).
4. Run `npm test`. `test/tools/evals/run-evals.test.mjs` validates every family's config and eval data, and `test/skills-conventions.test.mjs` requires a `config.json` and an `evals.json` for every skill, so a mistake fails there before it costs a run.
5. Run `npm run evals -- --family <family> --dry-run`, then a single case without `--dry-run`.
6. Add `evals/<family>/README.md` with anything specific to the family (cases that need live services, which assertions are `MANUAL`).

Nothing in `tools/` needs to change.

## Adding an eval kind or a check type

**A new kind** is a module in `tools/evals/kinds/` that default-exports:

```js
{ name,
  discover({ family, familyDir, config, skills, root }) → runs[]   // validate your data; throw on bad data
  outDir(run) → path under the iteration folder
  plan(run, ctx) → { args }                                         // for --dry-run
  execute(run, ctx) → writes artifacts into ctx.outDir              // may use tools/evals/claude.mjs
  grade(outDir, run, ctx) → grading object with `summary` and `run.error`  // a pure function of the saved artifacts
  summarize?(gradings) → object                                     // optional: stored as `kinds.<name>` in summary.json
  progress?(grading) → string                                       // optional: one extra stderr line after the run's progress line
}
```

Each run needs `kind`, `family`, `skill`, `caseId`, `variant`, and `label`. `plan` may also return `repeat` (shown in `--dry-run`), and `ctx` carries `runs` (`--runs`). `tools/evals/kinds/triggers.mjs` is a worked example that runs `claude` several times per run. Import the module in `tools/run-evals.mjs` and add it to the `KINDS` array. `--kind`, `--skill`, `--case`, `--regrade`, iteration numbering, and summaries then work for it. Add a test next to `test/tools/evals/output.test.mjs` or `triggers.test.mjs`.

**A new check type** is one entry in `CHECKS` in `tools/evals/checks.mjs`: `args` (each with a `kind` of `string`, `regex`, `path`, `number`, or `json`, and `optional: true` if not required) and `run(check, ctx)` returning `{ pass, evidence }`. `validateChecks` enforces the arguments automatically. Add a test to `test/tools/evals/checks.test.mjs` and a row to the table above. Checks that import repo code (such as `validate_local` importing `shared/workflow-automation/validation.mjs`) run in the runner's process, not in the sandbox.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `API Error: 400 Unreadable token` in a run | The eval session could not authenticate. The runner reads `apiKeyHelper` from `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`). If you authenticate another way, set `ANTHROPIC_API_KEY` in the shell you run the runner from. |
| `cannot run claude: ENOENT` | `claude` is not on your `PATH`. |
| `output already exists, nothing is overwritten` | That iteration already holds results. Omit `--iteration` to use the next number. |
| Many `permission_denials` in `grading.json` | The agent tried a tool outside the allowlist. If the skill needs it, extend `bashAllow` in the family's `config.json` with that script's exact path. |
| A run shows `ERROR: timed out` | Raise `--timeout`, or check `transcript.jsonl` for a loop. |
| `run-evals: ...evals.json: ...` | Your eval data failed validation; the message names the file and the field. |
