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
| Notify through a New Relic destination | `newrelic.notification.send`, `newrelic.notification.sendSlack`, `newrelic.notification.sendMicrosoftTeams`, `newrelic.notification.sendEmail` | Uses destinations already configured in New Relic, so no token secret is needed. Email reports with a list, table, or export: see [Email with attachments](#email-with-attachments). |
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

| Intent | Action | When |
|---|---|---|
| Convert epoch timestamps | `utils.datetime.fromEpoch` | Format one timestamp: `timestamp`, `timestampUnit` (`MILLISECONDS` default), `timezoneId`, `pattern`. Outputs `date`, `time`, `datetime`. |
| Convert data to CSV | `utils.transform.toCSV` | Turn a whole result list into CSV. Pass `${{ <list> \| tostring }}` as `data`; columns come out sorted alphabetically. Output `csv`. |
| Generate a UUID | `utils.uuid.generate` | |
| Run a Python script | `script.run` | Logic too complex for small jq. Python 3.13 only, a short import allowlist, parsing large amounts of json, no network or file access. |
| Sign a JWT | `auth.jwt.create` | |

## Expressions (jq)

`${{ }}` runs on New Relic's jq engine, which lacks some standard jq builtins. A jq error aborts the whole run, even on a step with `ignoreErrors: true`, and gives no reason, so a `switch` cannot catch it. Keep expressions small.

Prefer, in this order:
1. **NRQL.** Do time windows (`SINCE`), filtering, aggregation, and limits in the query, or let an email `QUERY` attachment run it.
2. **A utility action** ([Utilities](#utilities)) or a `selectors` path.
3. **Small jq**: filter, `map`, `length`, string concatenation, `// default`.
4. **`script.run`** when the logic is too complex for jq.

Gotchas:
- Not available: `todate`, `strftime`, `strptime`, `mktime`, `gmtime`, `fromdate`, `dateadd`, `IN`, `INDEX`, `abs`, `trim`/`ltrim`/`rtrim`, `pick`, `toarray`, `$ENV`/`env`, `input`, `add(f)`, `repeat`, `?//`. Use `todateiso8601`, `ltrimstr`/`rtrimstr`, and `any(<list>[]; . == $x)` instead of `IN`.
- `fromdateiso8601` rejects fractional seconds.
- `null | add` errors. Write `(.x // []) | add`.
- Floats print in exponent form (`tostring`, `@csv`, interpolation), and `round`/`floor`/`ceil` return floats (`84.0`). For integer text use `round | tostring`.
- In an `assign` step, an integer literal outside -2147483648..2147483647 (e.g. epoch ms) becomes a string, so arithmetic and `todateiso8601` on it fail. Write it as a float (`1793195378474.0`) or apply `tonumber` first. Action output stays numeric.
- `newrelic.nrdb.query` multi-`FACET` rows carry each facet attribute as its own key, with no `facet` array.

Safe patterns:
- One timestamp to a readable date: `utils.datetime.fromEpoch`.
- Epoch ms from action output to ISO 8601, e.g. per row inside `map`: `.timestamp / 1000 | floor | todateiso8601`. If the value may be a string: `tostring | .[0:10] | tonumber | todateiso8601`.
- A time cutoff NRQL `SINCE` cannot express (e.g. an `entitySearch` filter): `(now * 1000 | floor) - 3600000`.
- CSV from a list of maps: `utils.transform.toCSV`, or in jq `[["id","name"]] + (<list> | map([.id,.name])) | map(@csv) | join("\n")`. `@csv` keeps names with commas in one column.

## Email with attachments

Use `attachments` on `newrelic.notification.sendEmail` whenever the email carries a list, table, report, or export. Keep `message` to a short summary instead of building a long jq string in it. Confirm the shape with `describe newrelic.notification.sendEmail`; the sub-fields appear as `attachment.*` rows.

`attachments` is a list. Each entry has a required `type` and an optional `filename` (give it the matching extension; a name is generated if omitted):
- `QUERY`: `query` (NRQL), `accountIds` (defaults to the workflow's account), `format` (`JSON` default, `CSV`, `PSV`, `TSV`).
- `RAW`: `content` (a UTF-8 string).
- `DASHBOARD_SNAPSHOT`: `dashboardGuid` (required) and optional `dashboardParams`: `format` (`PDF` or `PNG`), `display.width`/`display.height` (10-2000), `variables` (`[{name, values[]}]`; a name the dashboard does not define fails the run), `timeWindow` (`duration`, or `beginTime` plus `endTime` in epoch ms, not both), `entityFilter` (without `WHERE`).

Choosing a type:
- Data comes from NRQL: use `QUERY`. It needs no jq and no separate `newrelic.nrdb.query` step when the query feeds only the attachment.
- Data comes from elsewhere (NerdGraph, HTTP): use `RAW` with CSV built by `utils.transform.toCSV` or the `@csv` pattern above.
- The user names a dashboard: use `DASHBOARD_SNAPSHOT`.

```yaml
      attachments:
        - type: QUERY
          query: "SELECT count(*) FROM Log WHERE level = 'ERROR' FACET message SINCE 1 day ago LIMIT 20"
          format: CSV
          filename: top_errors.csv
```

```yaml
      attachments:
        - type: RAW
          filename: entities.csv
          content: ${{ .steps.toCsv.outputs.csv }}
```

Outputs: `success`, `sessionId`, `errorMessage`, `attachments` (`blobId`, `rowCount`). Check `success` after the call when the email matters. Source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/newrelic/notification/newrelic-notification-sendemail/

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
