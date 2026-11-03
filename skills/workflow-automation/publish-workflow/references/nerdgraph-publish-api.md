# NerdGraph Workflow Automation API (publish operations)

## Contents
- Endpoints and authentication
- Publish flow
- Create a workflow
- Update a workflow
- Notes
- Sources

## Endpoints and authentication

| Region | Endpoint |
|---|---|
| US | `https://api.newrelic.com/graphql` |
| EU | `https://api.eu.newrelic.com/graphql` |
| JP | `https://api.jp.newrelic.com/graphql` |

`POST` with headers `Content-Type: application/json` and `API-Key: <User API key>`. Body: `{"query": "...", "variables": {...}}`.

## Publish flow

There is no "publish" mutation. `publish-workflow.mjs` does:

1. Local checks and server validation (`workflowDefinitionValidation` query). No publish without a successful server validation.
2. `ListWorkflows` query; look for the YAML's exact `name:`.
3. Exact name found: `GetWorkflow` for the latest version, diff, then Update. Only a case-insensitive match found: `conflict` (not publishable; `apply` refuses with no mutation). No match: Create.
4. `plan` returns an `expect` token: `create#<sha12>` or `update@<currentVersion>#<sha12>`, where `sha12` is a short digest that binds the confirmation to the exact file bytes that would be published, the account id, and the region; the `create`/`update@<currentVersion>` prefix binds the action and base version. `apply --expect <token>` re-runs steps 1–3 and sends the mutation only if it computes the same token, so a version published by someone else after the plan, or any edit to the file (including line endings), is refused. A bare `create`/`update` is rejected. The token is a consistency check between what the user confirmed and what is sent, not authentication.

## Create a workflow

```graphql
mutation CreateWorkflow($scopeId: String!, $yaml: SecureValue!) {
  workflowAutomationCreateWorkflowDefinition(scope: {id: $scopeId, type: ACCOUNT}, definition: {yaml: $yaml}) {
    definition { definitionId name version description }
  }
}
```

Returns an error if a workflow with that name already exists. Verified live: names are **case-insensitive** for uniqueness. For example, if `example_workflow` exists, creating `Example_Workflow` fails with the GraphQL error `Workflow definition with this name already exists.`

## Update a workflow

```graphql
mutation UpdateWorkflow($scopeId: String!, $yaml: SecureValue!) {
  workflowAutomationUpdateWorkflowDefinition(scope: {id: $scopeId, type: ACCOUNT}, definition: {yaml: $yaml}) {
    definition { definitionId name version description }
  }
}
```

There is no name argument: the workflow is identified by the YAML's top-level `name:`. Returns an error if no workflow with that name exists. Each update adds a new version.

## Notes

Verified by live introspection:

- Full signatures: `workflowAutomationCreateWorkflowDefinition(definition: {yaml: SecureValue!}, scope: WorkflowAutomationScopeInput!, tags: [WorkflowAutomationTag!])`, and the same for `workflowAutomationUpdateWorkflowDefinition`. Both return `{ definition { definitionId name version description } }`. Tags are not used in v1.
- `input WorkflowAutomationScopeInput { id: String!, type: WorkflowAutomationScopeType }`, where `type` defaults to `ACCOUNT`. The account id goes in `scope.id` as a **String**, although queries take `accountId` as an `Int`.
- `yaml` is the YAML text, base64-encoded.
- Failures come back only as top-level GraphQL `errors`; the script reports them as `NerdGraph error: ...` (exit 2).
- Workflow names are unique case-insensitively (verified live, see Create). Whether Update with different letter casing targets the existing workflow is **not** verified, so the script never attempts it; it reports `conflict` and the user decides whether to change `name:` to the exact existing casing.
- Workflow names are immutable. A definition with a different `name` is a new, separate workflow, so the script never rewrites `name:`.

## Sources

- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/using-workflow-automation-api/
- https://docs.newrelic.com/docs/workflow-automation/workflow-automation-apis/definition-schema/
- https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph
