---
title: Send an email
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/newrelic/notification/newrelic-notification-sendemail
---

Sends an email through a New Relic email destination.

## Send an email

The action identifier is `newrelic.notification.sendEmail`.

### Inputs

| Input                   | Type   | Description                                                                                  | Example                   |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------- | ------------------------- |
| **destinationId**       | String | **Required.** DestinationId associated with the New Relic destination.                       | `123e4567-e89b-12d3`      |
| **subject**             | String | **Required.** Subject of the email.                                                          | `Daily report`            |
| **message**             | String | **Required.** Message to send in the email.                                                  | `See the attachment`      |
| **attachments**         | List   | **Optional.** A list of optional attachments.                                                |                           |
| **attachment.type**     | Enum   | **Required.** The content type of the attachment: QUERY, RAW, or DASHBOARD_SNAPSHOT.         | `QUERY`                   |
| **attachment.query**    | String | **Optional.** For QUERY type, the NRQL query statement.                                      | `SELECT * FROM Log`       |
| **attachment.filename** | String | **Optional.** A filename for the attachment. If omitted, a name is generated automatically.  | `log_count.csv`           |
| **selectors**           | List   | **Optional.** Selectors to extract specific fields from the output.                          |                           |

### Outputs

| Output           | Type    | Description                                     |
| ---------------- | ------- | ----------------------------------------------- |
| **success**      | Boolean | `true` on success, `false` on failure.          |
| **errorMessage** | String  | Failure reason as message. `null` on success.   |
