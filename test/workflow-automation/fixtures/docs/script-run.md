---
title: Script run action
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/utils/script-run
---

This page provides a comprehensive reference for the `script.run` action available in the workflow automation actions catalog. This action enables you to execute Python scripts within your workflows for data transformation, processing, and custom operations.

## Run a script [#script-run]

Execute a python script and returns the response to a workflow.

### Inputs

| Input          | Type   | Description                                           | Example                                        |
| -------------- | ------ | ----------------------------------------------------- | ---------------------------------------------- |
| **script**     | String | **Required.** Any data transformation script          | ```yaml script: |   print("Hello, World!") ``` |
| **runtime**    | Enum   | **Required.** Run time version of script              | `PYTHON_3_13`                                  |
| **parameters** | List   | **Optional.** list of parameters to be used in script | `parameters: ["--a", "10", "--b", "5"]`        |

### Outputs

| Output           | Datatype | Examples                                              |
| ---------------- | -------- | ----------------------------------------------------- |
| **success**      | Boolean  | `true/false`                                          |
| **payload**      | Object   | `"sessionId": "7fa97f26-3791-492e-a39b-53793163dfb9"` |
| **errorMessage** | String   | `parsing error at line 9"`                            |

