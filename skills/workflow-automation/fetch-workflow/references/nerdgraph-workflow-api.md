# NerdGraph Workflow Automation API (fetch operations)

## Contents
- Endpoints and authentication
- List workflows
- Get one workflow
- Notes and unverified assumptions
- Sources

## Endpoints and authentication

| Region | Endpoint |
|---|---|
| US | `https://api.newrelic.com/graphql` |
| EU | `https://api.eu.newrelic.com/graphql` |
| JP | `https://api.jp.newrelic.com/graphql` |

`POST` with headers `Content-Type: application/json` and `API-Key: <User API key>`. Body: `{"query": "...", "variables": {...}}`.

## List workflows

```graphql
query ListWorkflows($accountId: Int!, $cursor: String) {
  actor { account(id: $accountId) { workflowAutomation {
    workflows(cursor: $cursor) { nextCursor results { definition { name version } } }
  } } }
}
```

- Returns names and versions only (no YAML). A given workflow can have many versions (i.e: 1 workflow that has 7 versions will return 7 objects in the response).
- `fetch-workflow.mjs list` follows `nextCursor` (max 50 pages) and groups results by name.

## Get one workflow

```graphql
query GetWorkflow($accountId: Int!, $name: String!, $version: Int!) {
  actor { account(id: $accountId) { workflowAutomation {
    workflow(name: $name, version: $version) { definition { name version yaml } }
  } } }
}
```

- `version` is required by the API; the script resolves the latest version via the list query when `--version` is omitted.
- `yaml` is returned base64-encoded; the script decodes it before saving.

## Notes

- Workflow names match `^[A-Za-z_][A-Za-z0-9_-]*$` (max 100 chars) and are case-insensitive. A name is immutable once the workflow is created; a definition with a different name is a different workflow, so `list` groups versions by name.
- The list pagination field name `nextCursor` is used to paginate via `cursor` field.
- The argument type of `version` is `Int`.
- Workflow Automation requires Advanced Compute (aCCU) licensing on the account.

## Sources

- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/using-workflow-automation-api/
- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/definition-schema/
- https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph
