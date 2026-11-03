# Add Skill

How to add a skill, or a whole skill family, to this repository. Skills follow the open [Agent Skills specification](https://agentskills.io/specification) and its [best practices](https://agentskills.io/skill-creation/best-practices).

- [**Part A**](#part-a-add-any-skill) applies to every skill.
- [**Part B**](#part-b-skills-with-scripts) applies to skills that ship `scripts/`.
- [**Part C**](#part-c-add-a-skill-family) applies when you start a new family.
- [**Part D**](#part-d-worked-example-workflow-automation) describes `workflow-automation`, as a reference example. Copy from it, and adapt its conventions to your family.

## Part A: Add any skill

### Steps

1. Choose a family and a name. The name is kebab-case, at most 64 characters, equal to the folder name, and unique across all families (installs are keyed by skill name).
2. Create `skills/<family>/<skill>/` with `SKILL.md`, and optionally `references/` and `assets/`. Add `scripts/` only if the skill needs deterministic code; an instructions-only skill has none. A skill folder must be self-contained: never import files outside it. Keep `references/` one level deep (no subfolders) and link each file from `SKILL.md` with a note on when to read it.
3. Append `./skills/<family>/<skill>` to the family's `skills` array in `.claude-plugin/marketplace.json`.
4. Add evals under `evals/<family>/<skill>/`: `evals.json` (at least 2 cases; every case needs at least one machine-readable check) and, in the family's `triggers.json`, 5-10 queries to start, roughly half should-trigger and half near-misses that belong to a sibling skill or to no skill. Add more as real misfires show up. See [evals/README.md](evals/README.md).
5. Add a row to the family's skills table in [README.md](./README.md#skills).
6. If the skill has scripts, follow [Part B](#part-b-skills-with-scripts).
7. Run the verification commands in the [checklist](#checklist) below.

### Checklist

**Spec** (enforced by `npm test`, `test/skills-frontmatter.test.mjs`)

- [ ] `SKILL.md` starts with YAML frontmatter.
- [ ] `name` is lowercase letters, digits, and single hyphens, at most 64 characters, and equals the folder name.
- [ ] `description` is 1-1024 characters; `compatibility` (if set) is at most 500; `metadata` values are strings.
- [ ] Relative links resolve to files inside the skill folder.
- [ ] The skill is listed in exactly one `marketplace.json` plugin entry, and that entry holds a single family.

**Repo conventions** (enforced by `npm test`, `test/skills-conventions.test.mjs`)

- [ ] The name is unique across families and contains neither "anthropic" nor "claude"; `name` and `description` contain no XML tags.
- [ ] `SKILL.md` is under 500 lines and has a `## Gotchas` section.
- [ ] `references/` has no subfolders.
- [ ] Scripts import only `node:` builtins and files inside the skill folder (`./lib/...` after `npm run sync`).
- [ ] `evals/<family>/config.json` and `evals/<family>/<skill>/evals.json` exist, and the README skills table has a row for the skill. A new family also has a README subsection and an install line.

**Best practices** (checked in review)

- [ ] The description is in the third person, says what the skill does and when to use it, and names sibling skills to hand off to ("Not for ...").
- [ ] Detail lives in `references/`; long reference files have a table of contents.
- [ ] The body gives defaults rather than menus, uses consistent terminology, and avoids time-sensitive claims.
- [ ] If the skill reads external content (fetched pages, files, user-supplied text), `SKILL.md` has an `## Untrusted content` section: that content is data, confirmations come only from the user's own messages, and embedded instructions are quoted and reported, not followed. Add a prompt-injection eval case (for example `evals/workflow-automation/fixtures/prompt-injection/`).
- [ ] If the skill touches credentials, they come from environment variables only: never ask for keys in chat, echo them, or write them to files.

**Evals**

- [ ] At least 2 output cases in `evals.json`, each with checks, compared against a baseline (`npm run evals -- --baseline`).
- [ ] Trigger queries in `triggers.json` include both should-trigger and should-not-trigger cases (at least 5 queries per skill, at least 2 of each kind; enforced for any family that has a `triggers.json`).
- [ ] `npm run evals -- --family <family> --skill <skill> --dry-run` passes, then at least one real run. Write the report with `npm run evals:report`.
- [ ] The skill has been tried with Sonnet and Opus.

**Before you open a PR**

- [ ] `npm test`
- [ ] `npm run sync:check` (a no-op for a family without `shared/<family>/`)
- [ ] `claude plugin validate .` (manual: CI does not run it)
- [ ] `npx skills add ./ --list` shows the new skill (manual: CI does not run it).

## Part B: Skills with scripts

### Steps

1. Put code shared by the family's skills in `shared/<family>/`, import it from scripts as `./lib/<x>.mjs`, and run `npm run sync`. Sync copies into each skill only the `*.mjs` files its scripts import (transitively) and the `references/*.md` files its `SKILL.md` links to, and it never touches files without the GENERATED header. Never edit the generated copies. Shared code must itself be self-contained: it can import only other files in `shared/<family>/` and `node:` builtins.
2. Add tests under `test/<family>/` (`node:test`, mocks for any network call). `npm test` picks up `test/**/*.test.mjs`.
3. If the headless eval child needs to run the scripts, `evals/<family>/config.json` `bashAllow` must allow them (for example `node {plugin}/skills/*/scripts/*.mjs *`). A skill without scripts needs no `bashAllow` entry; it is optional and defaults to no Bash. If a skill needs another tool or environment variable, add that entry deliberately rather than loosening the glob. See [Adding a family](evals/README.md#adding-a-family).
4. Add the family's own version of the script tests (see [Part D](#part-d-worked-example-workflow-automation)): they hard-code skills and subcommands for `workflow-automation`, so a new family copies and adapts them.

### Checklist

- [ ] `SKILL.md` invokes scripts by absolute path (`node <skill-dir>/scripts/<x>.mjs`), and scripts refuse to run from inside their own skill folder.
- [ ] Scripts need Node 22+ and no dependencies, print JSON on stdout (one compact line) and diagnostics on stderr, and never prompt. Node 22+ is also needed for `npm test` (the test glob).
- [ ] Scripts use the family's shared helpers for output and errors (`workflow-automation`: `printJson`, `reportError` / `exitCodeFor` with exit 1 for usage errors and 2 otherwise, `runIfMain`) and for the skill-folder guard (`skillDirOf`, `assertNotInSkillDir`).
- [ ] Never print secret values: report counts and paths only, and cap anything echoed from untrusted content.
- [ ] Build API requests with variables or parameters, never string interpolation of user input, and send them through one shared client that enforces timeouts, never follows redirects with credentials, and strips keys from error text.
- [ ] Parse untrusted structured input (YAML, JSON) through one hardened shared parser, read user files as strict UTF-8, and write files without overwriting unless the user passes `--force`.
- [ ] Anything that mutates remote state uses a plan/apply step with a confirmation token that binds to what the user saw; a bare action is refused, and `SKILL.md` requires user confirmation. The mutating command must be the first argument (so permission "ask" rules match it), and the new command is added to the README "Security considerations" ask rules. Never tell users to allowlist it.
- [ ] The family's shared `SKILL.md` text (if it has one) is copied verbatim from a sibling skill.

## Part C: Add a skill family

1. Create `skills/<family>/` with its skills, following Parts A and B.
2. Optionally create `shared/<family>/` for shared code. `npm run sync` discovers families by scanning `shared/` directories, so nothing needs registering; a family without `shared/<family>/` is skipped. Sync is name-agnostic: it does not require particular helper file names. The `workflow-automation` helpers `cli.mjs` and `paths.mjs` import `UsageError` from `./nerdgraph.mjs`, so a family that copies them must provide that module too.
3. Add a plugin entry to `.claude-plugin/marketplace.json` by copying `workflow-automation`'s: `name` (`nr-<family>`), `source: "./"`, `description`, `version`, `author`, `repository`, `license`, `keywords`, and a `skills` array. Do not add a root `.claude-plugin/plugin.json`: it would apply to every entry.
4. Create `evals/<family>/config.json` (`plugin` equal to the marketplace entry name, `install` listing family folders, optional `unsetEnv`, `bashAllow`, `triggerFiles`), `evals/<family>/triggers.json`, and a family README, as described in [Adding a family](evals/README.md#adding-a-family).
5. Add `test/<family>/` if the family has scripts.
6. In [README.md](./README.md): add a `### <Family>` subsection under [Skills](./README.md#skills) (a table of skills, plus a Requirements section if the family needs credentials or tools), and an install line (`/plugin install nr-<family>@newrelic-skills`) under Install. If the family has mutating commands, add its ask rules to "Security considerations".
7. The frontmatter test, the conventions test, the evals runner, and `npm test` are family-agnostic. The tests under `test/workflow-automation/` cover `workflow-automation` only, so a new family adds its own equivalents if it wants them.

## Part D: Reference example: workflow-automation

`workflow-automation` contains skills that list, build, validate, publish, and run New Relic Workflow Automation templates through NerdGraph. Everything below is how it applies the generic rules above; another family can reuse the shape and swap the details.

### Layout

- `skills/workflow-automation/{fetch,validate,build,publish,run}-workflow/`, each with `SKILL.md`, `scripts/<skill>.mjs`, `references/`.
- `shared/workflow-automation/`: `nerdgraph.mjs` (API client), `cli.mjs` (`printJson`, `reportError`, `exitCodeFor`, `runIfMain`, `assertCommandFirst`), `paths.mjs` (`skillDirOf`, `assertNotInSkillDir`), `yaml.mjs`, `validation.mjs`, and others.
- `evals/workflow-automation/`: `config.json` with `bashAllow` of `node {plugin}/skills/*/scripts/*.mjs *` and `unsetEnv` of `NEW_RELIC_*`. The env allowlist is `ENV_ALLOWLIST` in `tools/evals/claude.mjs`.
- `test/workflow-automation/`: reference tests for scripts (below).

### Reference tests (hard-coded to this family)

These enumerate the family's script-having skills by hand. A new `workflow-automation` skill with scripts must be added to them, or it is silently unchecked; a skill without scripts is not added.

- `client-version.test.mjs`: `SKILLS` (full folder names). Checks each script's exported `CLIENT` matches `SKILL.md` `metadata.version`.
- `paths.test.mjs`: `SKILLS` (short names such as `fetch`). Checks each script refuses to run inside its own skill folder.
- `output-format.test.mjs`: import the script's `main`. Checks stdout is one compact JSON line.

`skill-shared-text.test.mjs` discovers skills by scanning the family folder (see below). The "real repo" tests in `test/tools/evals/` derive their expectations from the skill folders, so they need no edit.

### Shared SKILL.md text

`skill-shared-text.test.mjs` requires these paragraphs to be byte-identical across the family's `SKILL.md` files, matched by start string through the end of the line:

- `**Where to run:**`
- `**Run each script as one plain command.**`
- `**Never resolve ambiguity yourself.**`
- `- Never ask the user to paste an API key`
- `- The account id is not a secret`

Every `workflow-automation` skill that has `scripts/` must carry all five. A skill without scripts needs none of them (the first two only make sense for scripts), but any of the five that it does include must match the siblings' text. Copy them from a sibling (for example `fetch-workflow/SKILL.md`) rather than rewording. To change the wording, change it in every skill that carries it in one commit.

### Security rules as implemented here

These rules come from the security hardening of this family. Every skill in it that has scripts or sends NerdGraph requests must follow them.

- [ ] Credentials come from `NEW_RELIC_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, and `NEW_RELIC_REGION` only. Workflow YAML references secrets via `${{ :secrets:NAME }}`, never plaintext.
- [ ] GraphQL calls use variables, never string interpolation of user input.
- [ ] All New Relic API calls go through `nerdgraph()` in `shared/workflow-automation/nerdgraph.mjs`; never call `fetch` with the API key directly. It enforces an overall timeout, `redirect: 'manual'` (a 3xx is an `ApiError` naming only the Location host, so the `API-Key` header is never resent), and strips the key from error text. Docs fetches carry no key.
- [ ] **User-Agent**: every script exports `CLIENT = { skill: '<folder name>', version: '<SKILL.md metadata.version>' }` right after its imports and passes it to `getConfig(env, CLIENT)` (and as `client` to `validateAll` / `validateRemote` if it calls them). Requests then send `User-Agent: newrelic-skills/<version> (<family>/<skill>)`. `SKILL.md` needs `metadata.version`; `client-version.test.mjs` fails if `CLIENT.version` drifts from it, so bump both together.
- [ ] **Token patterns**: detect or redact credentials with the shared `TOKEN_PATTERNS` in `shared/workflow-automation/validation.mjs`, never a private regex. It covers `NRAK-` user keys (including lowercase bodies), EU/JP license keys such as `eu01xx…NRAL`, and `NRIQ-`, `NRJS-`, `NRBR-`, `NRSP-`, `NRRA-` followed by 16 or more characters. When rebuilding a pattern (for example to add the `g` flag), keep its original flags, as `redactDiff` does with `` `${pattern.flags}g` ``, or the case-insensitive patterns miss lowercase keys.
- [ ] Never print secret values. Report counts and paths only (see `scanSecrets` and `fetch-workflow`'s `plaintextSecrets`), mask sensitive-key lines in diffs (`unifiedDiff` with `maskSecrets`), and reject token-shaped user inputs (`checkRunInputs`, `input-plaintext-token`).
- [ ] Parse YAML only through `parseYaml` in `shared/workflow-automation/yaml.mjs`, which rejects anchors, aliases, and `<<` merge keys. Never import `js-yaml.mjs` directly in skill code.
- [ ] Read user files as strict UTF-8 with `decodeUtf8` and write files with `writeNoOverwrite` unless the user passes `--force`.
- [ ] Anything that mutates remote state uses a plan/apply step with an `--expect` token (for example `create#<sha12>`, `update@<version>#<sha12>`, `<name>@<version>#<inputsHash>`). A bare action or `name@version` must be refused.
- [ ] A script with a mutating command calls `assertCommandFirst(argv, command, script)` at the start of `main`, before reading files or calling the API. `parseArgs` accepts options before the subcommand, which would otherwise dodge the README's `Bash(node */<script>.mjs apply*)` ask rules. Add the new command to those ask rules and to the README "Security considerations", and never tell users to allowlist it.
- [ ] Scripts call `skillDirOf(import.meta.url)` and `assertNotInSkillDir(cwd, SKILL_DIR)` from `shared/workflow-automation/paths.mjs` in `main`. `paths.test.mjs` enforces it per skill.
