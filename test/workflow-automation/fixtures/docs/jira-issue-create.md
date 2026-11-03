---
title: Create a Jira issue
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/jira/jira-issue-create
---

Creates a new Jira issue.

For authentication setup, see [Jira issue actions](https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/jira/jira-issue).

## Inputs

| Input             | Type   | Description                                                                                                                                                                                                                                                                   | Example                                                                     |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **authToken**     | String | **Required.** Base64-encoded string of `email:API_Token` for Basic Authentication. Must be provided as a secret. See [Create and manage API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).                                                             | `"${{ :secrets:jiraAuthToken }}"`                                           |
| **domain**        | String | **Required.** Your Jira Cloud instance domain (company name). Used to construct the base URL `your-domain.atlassian.net`.                                                                                                                                                     | `"mycompany"`                                                               |
| **projectKey**    | String | **Required.** The key of the Jira project in which to create the issue.                                                                                                                                                                                                       | `"PROJ"`                                                                    |
| **summary**       | String | **Required.** A brief summary or title for the new issue.                                                                                                                                                                                                                     | `"Fix bug in login page"`                                                   |
| **description**   | String | **Required.** A detailed description for the issue.                                                                                                                                                                                                                           | `"Users are unable to log in."`                                             |
| **issueTypeName** | String | **Required.** The type of issue to create.                                                                                                                                                                                                                                    | `"Bug"` or `"Story"`                                                        |
| **parentKey**     | String | **Optional.** The key of the parent issue. Used to create subtasks or child issues.                                                                                                                                                                                           | `"PROJ-123"`                                                                |
| **labels**        | List   | **Optional.** A list of labels to apply to the issue.                                                                                                                                                                                                                         | `["alerting", "p1"]`                                                        |
| **fields**        | Map    | **Optional.** A map for all other issue fields not listed above, including priority, assignee, components, and custom fields. To get all fields with allowed values for an issue type, use `GET /rest/api/3/issue/{issueKey}/editmeta`. See the fields reference table below. | `{"priority": {"name": "Highest"}, "assignee": {"accountId": "5e6b8c..."}}` |
| **selectors**     | List   | **Optional.** A list of named expressions to extract specific values from the response.                                                                                                                                                                                       | `[{"name": "summary", "expression": ".responseBody.result.summary"}]`       |

> #### ⚠️ FIELDS REFERENCE
>
> | Field                 | Type    | Description                                                                      |
> | --------------------- | ------- | -------------------------------------------------------------------------------- |
> | **priority**          | Object  | Issue priority. Example: `{"name": "High"}`                                      |
> | **assignee**          | Object  | User to assign the issue to. Example: `{"accountId": "5e6b8c..."}`               |
> | **reporter**          | Object  | User reporting the issue.                                                        |
> | **components**        | Array   | Project components to associate with the issue. Example: `[{"name": "Backend"}]` |
> | **duedate**           | Date    | Due date for the issue. Example: `"2025-12-31"`                                  |
> | **fixVersions**       | Array   | Fix version(s) for the issue.                                                    |
> | **environment**       | String  | Description of the environment in which the issue occurred.                      |
> | **customfield_10016** | Integer | Story point estimate.                                                            |
> | **customfield_10001** | Team ID | Team associated with the issue.                                                  |
> | **customfield_10020** | Array   | Sprint association.                                                              |
> | **customfield_10022** | Date    | Target start date.                                                               |
> | **customfield_10023** | Date    | Target end date.                                                                 |

## Outputs

| Output           | Type    | Example                                                                                                                                    |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **response**     | Object  | ```yaml {   "id": "10001",   "key": "PROJ-124",   "self": "..." } ```                                                                      |
| **success**      | Boolean | `success: true | false`                                                                                                                    |
| **errorMessage** | String  | ```yaml {   "errorMessages": [],   "errors": {     "project": "Project is required.",     "issuetype": "Issue type is required."   } } ``` |

