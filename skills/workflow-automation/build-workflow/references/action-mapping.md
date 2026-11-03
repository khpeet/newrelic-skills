---
title: Action mapping cheat sheet
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/actions-catalog
---

# Action mapping cheat sheet

Starting points for turning common requests into actions. These names were checked against a live `actionDefinitions` catalog. Before you use one, confirm it with `build-workflow.mjs actions --search` and `describe`. With an API key, the account's live catalog is authoritative: if an action is missing there, it is not available to the workflow. Action names are case-sensitive and the live catalog's casing wins over the docs: for example `gitHub.*`, `pagerDuty.*`, and `serviceNow.*`. `describe` always returns the canonical name.

Action names follow `company.product.action`. Every action step needs `version`, an integer: use the version `describe` returns.

> Verified against the live catalog in 2026-10: 259 actions; all action versions were 1.

## New Relic

| Intent | Action | Notes |
|---|---|---|
| Run an NRQL query | `newrelic.nrdb.query` | `query` (required), `accountIds`, `format`. Output `results`. |
| Call any NerdGraph query or mutation | `newrelic.nerdgraph.execute` | Use only when no dedicated action exists. |
| Query with Lens | `newrelic.lens.query` | |
| Send custom events / logs / metrics | `newrelic.ingest.sendEvents`, `newrelic.ingest.sendLogs`, `newrelic.ingest.sendMetrics` | Use for audit trails and failure logging. |
| Notify through a New Relic destination | `newrelic.notification.send`, `newrelic.notification.sendSlack`, `newrelic.notification.sendMicrosoftTeams`, `newrelic.notification.sendEmail` | Uses destinations already configured in New Relic, so no token secret is needed. |
| Human approval link | `newrelic.notification.createSignalUrl` | Must be paired with a notification step and a `wait` step that has `signals`; `waitStepName` must name that wait step. |
| Start another workflow | `newrelic.workflowAutomation.startWorkflowRun` | |
| List / acknowledge / resolve issues | `newrelic.issue.list`, `.acknowledge`, `.unacknowledge`, `.resolve` | |
| Alert policies, NRQL conditions, muting rules | `newrelic.alerts.*` | For example `newrelic.alerts.createPolicy`. |
| Tag entities | `newrelic.tagging.addTags`, `newrelic.tagging.replaceTags`, `newrelic.tagging.deleteTags`, `newrelic.tagging.deleteTagValues` | |
| Synthetic monitors and downtimes | `newrelic.synthetics.*` (for example `newrelic.synthetics.listMonitors`, `newrelic.synthetics.createMonitorDowntime`) | No docs page yet: rely on the live `describe`. |
| Service levels | `newrelic.serviceLevel.create`, `.list`, `.update`, `.delete` | |
| AI analysis / root cause | `newrelic.agent.run`, `newrelic.autopilot.run` | |

## Messaging and ITSM

| Intent | Action | Notes |
|---|---|---|
| Post to Slack with a bot token | `slack.chat.postMessage` | `token` must be a secret, for example `${{ :secrets:slack:botToken }}`. Prefer `newrelic.notification.sendSlack` when a New Relic Slack destination exists. |
| Read Slack reactions (lightweight approvals) | `slack.chat.getReactions` | |
| PagerDuty incidents | `pagerDuty.incident.create`, `.get`, `.list`, `.update`, `.resolve` | |
| ServiceNow incidents | `serviceNow.incident.create`, etc. | `apiKey` must be a secret. |
| Jira issues | `jira.issue.create`, etc. | `authToken` must be a secret. |
| GitHub issues | `gitHub.issue.create`, etc. | `token` must be a secret. |

## HTTP, cloud, and CI/CD

| Intent | Action | Notes |
|---|---|---|
| Call a REST API | `http.get`, `http.post`, `http.put`, `http.patch`, `http.delete` | `headers` and `urlParams` take a stringified JSON object. Put credentials in headers as secret references. Parse JSON with a selector: `.responseBody \| fromjson`. |
| AWS | `aws.<service>.<operation>` (for example `aws.ec2.describeInstances`, `aws.ec2.rebootInstances`, `aws.lambda.invoke`) | Prefer `awsRoleArn` over access keys. If you use keys, both must be secrets. |
| Azure | `azure.*` (VM restart/stop, App Service restart, AKS scale pool, Functions invoke, Cosmos DB, Monitor log queries) | |
| Ansible | `ansible.job.launch`, `ansible.job.getStatus` | |
| Jenkins | `jenkins.job.trigger`, `jenkins.job.getStatus`, `jenkins.job.getConsoleOutput`, `jenkins.queue.*` | |

## Utilities

| Intent | Action |
|---|---|
| Convert epoch timestamps | `utils.datetime.fromEpoch` |
| Convert data to CSV | `utils.transform.toCSV` |
| Generate a UUID | `utils.uuid.generate` |
| Run a Python script | `script.run` |
| Sign a JWT | `auth.jwt.create` |

## Alert-triggered workflows

A workflow that New Relic alerts start through a Workflow Automation destination (an inbound trigger). Source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/create-destinations/

Declare these two inputs exactly (names and types are fixed, no `defaultValue`, so both are required):

```yaml
workflowInputs:
  accountId:
    type: Int
  issueId:
    type: String
```

- Optionally restrict `issueId` to a UUID with a `regex` validation: `pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`, `type: regex`, plus an `errorMessage`.
- Reference with `${{ .workflowInputs.issueId }}` and `${{ .workflowInputs.accountId }}`. To get issue details, find an action with `actions --search issue`, or use `newrelic.nerdgraph.execute`.
- Other inputs: add a `defaultValue` when the user supplied one; otherwise leave them required. Alerts only supply `issueId` and `accountId` themselves.
- The wiring is UI-only (no API), so tell the user to do it after publishing:
  1. Alerts > Destinations > Workflow Automation: enter a name and an API key, then save.
  2. Alerts > Notification Workflows > Add a workflow: set filters, choose that destination in Notify, map `issueId` to `{{ issueId }}` (and set `accountId` and any other required inputs), then activate.
- Building the Alerts notification workflow itself is out of scope for this skill.

## Not actions: use step types

- **Branching or checking `success`**: a `switch` step.
- **Iterating over results**: a `loop` step (`for:` / `in:`).
- **Delays, polling, and approvals**: a `wait` step (`seconds`, `signals`).
- **Derived variables**: an `assign` step.
- **Values that persist across steps**: a `state` step.
- **Failing deliberately**: an `error` step.

## Doc inconsistencies to avoid

- `newrelic.nrql.query` appears in one example. The real action is `newrelic.nrdb.query`.
- `utils.http.post` and `newrelic.instrumentation.log` appear in schema examples. Use `http.post` and `newrelic.ingest.sendLogs`.
- `type: Number` for `workflowInputs` is not valid. Use `Int` or `Float`.
- Examples show `version` as both `1` and `'1'`. Either form parses.

## Examples

Example workflows by pattern (HTTP, loops, switch, Slack, AWS, approvals): https://docs.newrelic.com/docs/workflow-automation/workflow-examples/workflow-examples/
