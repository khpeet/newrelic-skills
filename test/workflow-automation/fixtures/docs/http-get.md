---
title: HTTP Get
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/http/http-get
---

This page provides a comprehensive reference for HTTP Get available in the workflow automation actions catalog. These actions enable you to perform HTTP GET request operations.

## Prerequisites

For prerequisites, see [HTTP actions](https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/http/http#prerequisites).

## Automatic request headers [#automatic-headers]

All HTTP requests performed by Workflow Automation automatically include the following headers:

| Header         | Format                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Abuse-Info` | `Request sent by a New Relic WorkflowAutomation. {runId}`where `{runId}` is the workflow run ID                                      |
| `User-Agent`   | `NewRelic/WorkflowAutomation (region={region}; https://newrelic.com ; support@newrelic.com)`where `{region}` is the New Relic region |

## GET web data [#http-get]

Perform an HTTP GET call to retrieve data from an API endpoint.

> #### ⚠️ IMPORTANT
>
> If you need to pass sensitive data to an input, for example an `Api-Key` header, you can use values stored via the [secretsManagementCreateSecret](https://onenr.io/0KQXX6BmdQa) NerdGraph mutation.
>
> **Example**
>
> ```yaml
> {
>   "inputs": [
>     {
>       "key": "headers",
>       "value": "{\"Api-Key\": \"${{ :secrets:NR_API_KEY }}\"}"
>     }
>   ]
> }
> ```

### Inputs

| Input         | Type   | Description                                                                                                                                                                                                                                            |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **url**       | String | **Required.** The target URL for the request. The scheme must be included: `https://example.com`. See [using workflow inputs](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/workflow-inputs) for dynamic values. |
| **urlParams** | Map    | **Optional.** The query parameters to append to the URL. Takes a stringified JSON object.                                                                                                                                                              |
| **headers**   | Map    | **Optional.** The headers to add to the request. Takes a stringified JSON object.                                                                                                                                                                      |
| **selectors** | List   | **Optional.** The selectors to get only the specified parameters as output.                                                                                                                                                                            |

#### Selectors

**Purpose:** Extract specific data from the API response.

**Structure:**

-   `name`: The variable name to store the extracted value
-   `expression`: JSONPath or expression to parse the response
-   Use `responseBody | fromjson` to parse JSON responses
-   Chain additional filters using dot notation (e.g., `.abbreviation`)

### Outputs

| Output           | Type    | Description                      |
| ---------------- | ------- | -------------------------------- |
| **responseBody** | String  | The body of the response.        |
| **statusCode**   | Int     | The status code of the response. |
| **success**      | Boolean | Status of the request.           |
| **errorMessage** | String  | Failure reason as message.       |

### Example

| Workflow definition                                                                                                                                                                                                                                                                                           | Input                                                                                                                                                                                                                                                                                                                                                                                                                                             | Output                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ```yaml name: httpGetTest steps:   - name: query     type: action     action: http.get     version: 1     inputs:       url: ${{ .workflowInputs.url }}       urlParams: ${{ .workflowInputs.urlParams }}       headers: ${{ .workflowInputs.headers }}       selectors: ${{ .workflowInputs.selectors }} ``` | ```yaml {   "inputs": [     {       "key": "url",       "value": "https://example.com"     },     {       "key": "urlParams",       "value": "{\"foo\": \"bar\"}"     },     {       "key": "headers",       "value": "{\"baz\": \"bat\"}"     },     {       "key": "selectors",       "value": "[{\"name\": \"responseBody\", \"expression\": \".responseBody\"}, {\"name\": \"statusCode\", \"expression\": \".statusCode\"}]"     }   ] } ``` | ```yaml Success case:   {     "responseBody": "<!doctype html>\n<html>...</html>\n",     "statusCode": 200     "success": true   }  Failure case:   {     "errorMessage": "An unexpected error failed to call http get endpoint.",     "success": false   } ``` |
