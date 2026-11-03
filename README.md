# New Relic Skills

Community built agent skills for New Relic. They follow the open [Agent Skills](https://agentskills.io) format and are compatible with Claude Code, Codex, Cursor, Gemini CLI, and other agents.

## Install

**Any agent** (via the [`skills`](https://github.com/vercel-labs/skills) CLI):

```bash
npx skills add khpeet/newrelic-skills                    # pick skills interactively
npx skills add khpeet/newrelic-skills -s fetch-workflow  # one skill
```

**Claude Code plugin:**

```text
/plugin marketplace add khpeet/newrelic-skills
/plugin install nr-workflow-automation@newrelic-skills
```

## Skills

### Workflow Automation (`skills/workflow-automation/`)

Work with [New Relic Workflow Automation](https://docs.newrelic.com/docs/workflow-automation/introduction-to-workflow/) remotely.

| Skill | What it does |
|---|---|
| `fetch-workflow` | List workflows in an account, or download one as YAML |
| `validate-workflow` | Validate a workflow YAML locally (YAML syntax, schema, limits, secrets, best practices), then server-validate in New Relic when credentials are set |
| `build-workflow` | Draft a workflow YAML from a plain-language description. Maps tasks to actions in the live `actionDefinitions` catalog (falls back to the docs catalog without credentials), references secrets instead of embedding them, saves to `./workflows/<name>.yaml`, then hands off to `validate-workflow` |
| `publish-workflow` | Publish a workflow YAML to New Relic: validates locally and on the server, then creates a new workflow or updates an existing one (showing a diff and version bump), only after the user confirms |
| `run-workflow` | Start a run of a published workflow in New Relic: checks the inputs against the definition, warns when a local file differs from the published version, and only after the user confirms starts the run, confirms it began, and returns the run's log URL. Also checks a run's status on request |

#### Requirements

- Node.js 22+
- A New Relic **User** API key with access to the target account, and Workflow Automation enabled on the account.

Set credentials as environment variables in your shell **before** starting your agent. Never paste API keys into an agent chat.

```bash
export NEW_RELIC_API_KEY=NRAK-...      # User API key
export NEW_RELIC_ACCOUNT_ID=1234567    # optional default account
export NEW_RELIC_REGION=US             # US (default), EU, or JP
```

## Development

Requires Node.js 22+ (same as the skill scripts); the test runner glob needs it.

```bash
npm test               # run tests
npm run sync           # copy shared/ code into each skill folder
npm run sync:check     # fail if skill copies are stale
npm run docs:check     # dev-only, needs network: diff docs mirrors against docs.newrelic.com (--update refreshes them)
npm run evals          # dev-only, spends Claude API credit: run the agent-level evals (see evals/README.md)
claude plugin validate .
npx skills add ./ --list
```

### Adding a skill

Skills follow the open [Agent Skills specification](https://agentskills.io/specification) and its [best practices](https://agentskills.io/skill-creation/best-practices).

The recommended flow is to draft a new skill with an agent (`skill-creator` or plain Claude) that has the spec, [ADD_SKILL.md](./ADD_SKILL.md), and a sibling skill to copy from (the `workflow-automation` family is the reference example, for instance [`fetch-workflow`](skills/workflow-automation/fetch-workflow/SKILL.md)). Then verify with the repo's own tests and evals.

See [ADD_SKILL.md](./ADD_SKILL.md) for the steps and checklist for adding a skill or family. A new family also adds its own subsection under [Skills](#skills) and, if it has mutating commands, its own ask rules under [Security considerations](#security-considerations).

### Evals

The agent-level evals under [`evals/`](evals/README.md) check what an agent does when it
follows a `SKILL.md`. They need the `claude` CLI on your `PATH`, logged in, and they cost about $0.10-$2 per case.

```bash
npm run evals -- --dry-run                           # list the planned runs; nothing runs
npm run evals -- --skill validate-workflow           # run one skill's evals
npm run evals -- --skill validate-workflow --case 1  # run one case
npm run evals                                        # run everything
```

Each case runs in a throwaway sandbox with your New Relic credentials removed. Results are saved to
`evals/workspace/<family>/iteration-<N>/` (git-ignored). Assertions that can be checked mechanically are graded
`PASS`/`FAIL`; the rest are marked `PARTIAL` or `MANUAL` for you to review in `grading.json`. See
[evals/README.md](evals/README.md) for every flag, how to read the results, and how to add evals for a new skill family.

## Security considerations

A `SKILL.md` is instructions to an agent, not a security boundary. Some of these skills use two-phase `plan` / `apply` (or `start`) commands, and the `--expect` token binds the confirmation to the exact plan the user saw (file bytes, version, inputs). But nothing in the code can tell a human "yes" from the agent's own decision, so the agent could still call `apply` or `start` itself, for example after reading an instruction hidden in fetched or pasted content. The only real gate is your agent's runtime approval prompt:

- Keep approval prompts on for shell commands, and never allowlist (auto-approve) `publish-workflow.mjs apply` or `run-workflow.mjs start`. Allow only exact read-only subcommand patterns, such as `plan`, `status`, `validate`, and the `list` subcommand of `fetch-workflow`. Commands that use `--force` (for example `get --force` or `write --force`) overwrite files, and `--out` writes to a chosen path, so keep those on ask.
- **Never allow `Bash(node:*)`, `node -e`, or any other broad `node` pattern.** A broad pattern defeats the `ask` rules below: an inline `node -e "import(...)"` or a direct `fetch()` call has no literal `publish-workflow.mjs apply` in its command line, so it matches no rule and runs without a prompt. It can also send `NEW_RELIC_API_KEY` to any host. Allow specific script subcommands instead.
- In Claude Code, force a prompt for those two commands with `ask` rules in `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": [
      "Bash(node */publish-workflow.mjs apply*)",
      "Bash(node */run-workflow.mjs start*)"
    ]
  }
}
```

`publish-workflow.mjs` and `run-workflow.mjs` refuse to run unless the command (`apply`, `start`, ...) is the first argument, so putting options before it cannot sidestep these rules. The scripts are invoked by absolute path whose prefix varies per install, hence the leading `*`. This rule syntax was checked against Claude Code: with `Bash(node:*)` allowed, a matching `apply` command was held for approval while `plan` ran. Other agents have their own equivalents (per-command approval or allow/deny lists); configure them so these two commands always require a human decision.

Known limitation: the `Update` mutation has no expected-version check on the server. If someone else publishes the same workflow between `apply`'s re-check and the mutation, that publish can be silently superseded by yours. The published bytes always equal the planned bytes.

## Support

This project is provided AS-IS WITHOUT WARRANTY OR DEDICATED SUPPORT.

## Contributing

Contributions are welcome. Please open an [issue](../../issues) or a pull request.

## License

This project is distributed under the [Apache 2 license](LICENSE).

### Third-party code

[`shared/workflow-automation/js-yaml.mjs`](shared/workflow-automation/js-yaml.mjs) is a vendored, unmodified copy of [js-yaml](https://github.com/nodeca/js-yaml) 4.3.2, which is licensed under the MIT license. Its copyright and license notice stays in the header of that file and of each skill's generated copy (`skills/workflow-automation/*/scripts/lib/js-yaml.mjs`).
