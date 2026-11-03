# NerdGraph Workflow Automation API (run operations)

## Contents
- Endpoints and authentication
- Run flow
- Start a workflow run
- Get run info
- Notes
- Sources

## Endpoints and authentication

| Region | Endpoint |
|---|---|
| US | `https://api.newrelic.com/graphql` |
| EU | `https://api.eu.newrelic.com/graphql` |
| JP | `https://api.jp.newrelic.com/graphql` |

`POST` with headers `Content-Type: application/json` and `API-Key: <User API key>`. Body: `{"query": "...", "variables": {...}}`.

## Run flow

`run-workflow.mjs` does:

1. `ListWorkflows` query; look for the exact name (from the target, or from a local file's `name:`). Not found: error. Only a case-insensitive match: refuse.
2. `GetWorkflow` for the chosen version (`--version` or latest); decode the YAML; compare it with the local file, if any (`localDiffers`); check the supplied inputs against its `workflowInputs`.
3. `start` only: `StartWorkflowRun` mutation pinned to that version, then `WorkflowRunInfo` after about 15 seconds (once more after another 15 seconds if it errors or returns nothing).

## Start a workflow run

```graphql
mutation StartWorkflowRun($scopeId: String!, $name: String!, $version: Int, $workflowInputs: [WorkflowAutomationWorkflowRunInput!], $idempotencyKey: ID, $options: WorkflowAutomationWorkflowRunOptions) {
  workflowAutomationStartWorkflowRun(scope: {id: $scopeId, type: ACCOUNT}, definition: {name: $name, version: $version}, workflowInputs: $workflowInputs, idempotencyKey: $idempotencyKey, options: $options) {
    runId
  }
}
```

- `workflowInputs` is a list of `{key, value}`. The script sends every value as a string; `List` and `Map` values are JSON-stringified. Inputs not supplied are omitted so the server applies their `defaultValue`.
- `version` is always sent (the version the user confirmed), so a version published between plan and start does not run.
- `plan` returns `expect` as `<name>@<version>#<inputsHash>`. `inputsHash` is a short digest that binds the confirmation to the supplied inputs (as sent), the log level, the account id, and the region. `start --expect <token>` recomputes the token and refuses on any difference in name, version, inputs, log level, account, or region. The token is a consistency check between what the user confirmed and what is sent, not authentication.
- `options` is `{logLevel}` when `--log-level` is given, otherwise `null`.

## Get run info

```graphql
query WorkflowRunInfo($accountId: Int!, $runId: ID!) {
  actor { account(id: $accountId) { workflowAutomation {
    workflowRunInfo(runId: $runId) { status logUrl state { key value } }
  } } }
}
```

`status` is one of `COMPLETED`, `FAILED`, `RUNNING`, `TIMED_OUT`. `logUrl` links to the run's logs in New Relic.

## Notes

Verified by live introspection:

- Full signature: `workflowAutomationStartWorkflowRun(definition: WorkflowAutomationStartWorkflowRunDefinitionInput!, idempotencyKey: ID, options: WorkflowAutomationWorkflowRunOptions, scope: WorkflowAutomationWorkflowRunScope!, workflowInputs: [WorkflowAutomationWorkflowRunInput!])`, returning `{ runId: ID }`.
- `WorkflowAutomationStartWorkflowRunDefinitionInput { name: String!, version: Int, scopeType }`.
- `WorkflowAutomationWorkflowRunScope { id: String!, type: ACCOUNT }`. The account id goes in `scope.id` as a **String**, although queries take `accountId` as an `Int`.
- `WorkflowAutomationWorkflowRunInput { key: String!, value: WorkflowAutomationRawWorkflowInputValue! }`.
- `WorkflowAutomationWorkflowRunOptions { logLevel: DEBUG | INFO | NONE | TRACE }`.
- `workflowRunInfo(runId: ID!)` returns `status: WorkflowAutomationWorkflowRunStatus!` (`COMPLETED | FAILED | RUNNING | TIMED_OUT`; there is no `STARTED`), `logUrl: String!`, and `state { key value }`.

From the docs only (not verified live):

- `idempotencyKey` must be a UUID. The script generates one with `crypto.randomUUID()` and requires a UUID for `--idempotency-key`. Retrying with the same key is expected not to start a second run.
- Input values are strings.
- Not verified: the exact bounds semantics of `minIntValue`/`maxIntValue` (the script treats them as inclusive), and whether the server's `regex` dialect matches JavaScript's (a pattern JavaScript cannot compile is left to the server with a warning).

## Sources

- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/start-workflow-run/
- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/workflow-run-info/
- https://github.com/newrelic/docs-website (`src/content/docs/workflow-automation/workflow-automation-apis/start-workflow-run.mdx`, `workflow-run-info.mdx`)
- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/definition-schema/
