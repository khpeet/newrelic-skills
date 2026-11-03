---
title: Run Autopilot action
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/newrelic/ai/newrelic-autopilot
---

This page provides a reference for the **Run Autopilot** action (`newrelic.autopilot.run`) available in the workflow automation actions catalog.

## Run Autopilot [#newrelic-autopilot-run]

Runs New Relic Autopilot — an AI agent that analyzes alerts, investigates potential root causes, and suggests remediation actions. You select **Run Autopilot** from the Workflow Editor's Action Catalog — you don't need to specify an agent ID.

### Inputs

| Input         | Type   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **prompt**    | String | **Required.** A prompt is your instruction to an AI Agent. It's the question you ask or the command you give to get a specific result.                                                                                                                                                                                                                                                                                                                                                                                    |
| **threadId**  | String | **Optional.** A unique identifier for the conversation thread in UUID format.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **context**   | List   | **Optional.** Additional contextual information for the request. This field has the following constraints: - **Structure**: Each element within the list must be an object strictly containing a `description` and a corresponding `value`. - **Capacity**: You may provide a maximum of 10 contextual items per request. - **Security**: Do not include secret references in this field. ```yaml context:   - description: accountId     value: "12345678"   - description: slack_channel_id     value: "CXXXXXXXXX" ``` |
| **selectors** | List   | **Optional.** The selectors to get only the specified parameters as output. Example: ```yaml selectors:   - name: success     expression: .success   - name: error     expression: .errorMessage   - name: response     expression: .response.finalAnswer ```                                                                                                                                                                                                                                                             |

### Outputs

| Output           | Type    | Description                |
| ---------------- | ------- | -------------------------- |
| **response**     | Object  | Response of the agent.     |
| **success**      | Boolean | Status of the request.     |
| **errorMessage** | String  | Failure reason as message. |

