---
title: Utilities - Transform
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/utils/utils-transform
---

This page provides a comprehensive reference for utilities - transform available in the workflow automation actions catalog. These actions enable you to data transformation utilities.

## Convert to CSV [#utils-transform-toCSV]

This is used to transform various type of input (JSON, map) to a CSV format.

### Inputs

| Input         | Type | Description                                                                                         |
| ------------- | ---- | --------------------------------------------------------------------------------------------------- |
| **data**      | any  | **Required.** A string representing a data to transform into CSV, typically a JSON string or a map. |
| **selectors** | List | **Optional.** The selectors to get the only specified parameters as output.                         |

### Outputs

| Field            | Datatype | Description                                              |                           |
| ---------------- | -------- | -------------------------------------------------------- | ------------------------- |
| **csv**          | string   | **Required.** A CSV representation of the data received. |                           |
| **success**      |          | Boolean                                                  | Status of the request     |
| **errorMessage** |          | String                                                   | Failure reason as message |

