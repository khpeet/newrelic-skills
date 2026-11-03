---
title: Post a Slack message
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/slack/slack-chat-post-message
---

Sends a message to a Slack channel with an optional file attachment.

For prerequisites, see [Slack chat actions](https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/slack/slack-chat#prerequisites).

## Post a message

The action identifier is `slack.chat.postMessage`.

Sends a message to a Slack channel, with an optional file attachment.

### Inputs

The following table describes all available input fields for this action.

| Input                   | Type   | Description                                                                                                                                                                                                                                                                                 | Example                                                                                                                |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **token**               | Secret | **Required.** The Slack bot token to use. This should be passed as a secret syntax. Refer to [Add Slack configuration](https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/slack/slack-chat#slack-configuration) for instructions on setting up a token. | `${{ :secrets:slackToken }}`                                                                                           |
| **channel**             | String | **Required.** The name of the channel, or a channelID, to send the message. See [Slack API](https://docs.slack.dev/reference/methods/chat.postMessage/#arg_channel) for more information.                                                                                                   | `my-slack-channel`                                                                                                     |
| **text**                | String | **Required.** The message to be posted to Slack in the specified `channel`.                                                                                                                                                                                                                 | `Hello World!`                                                                                                         |
| **threadTs**            | String | **Optional.** Timestamp belonging to parent message, used to create a message reply in a thread.                                                                                                                                                                                            | `<digits>.<digits>`                                                                                                    |
| **attachment**          | Map    | **Optional.** Allows attaching a file with a message onto the specified `channel`.                                                                                                                                                                                                          |                                                                                                                        |
| **attachment.filename** | String | **Required** when using `attachment`. Specify the filename for the uploaded file in Slack.                                                                                                                                                                                                  | `file.txt`                                                                                                             |
| **attachment.content**  | String | **Required** when using `attachment`. The content of the file to upload as UTF8.                                                                                                                                                                                                            | `Hello\nWorld!`                                                                                                        |
| **selectors**           | List   | **Optional.** The selectors to get only the specified parameters as output.                                                                                                                                                                                                                 | `[{\"name\": \"threadTs\", \"expression\": \".threadTs\"}, {\"name\": \"channelID\", \"expression\": \".channelID\"}]` |

### Outputs

The following table describes all output fields returned by this action.

| Output           | Type    | Description                                                                                                                           |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **threadTs**     | String  | Timestamp of the message thread. May be used in future `postMessage` calls to post a reply in a thread. Example: `<digits>.<digits>`. |
| **channelID**    | String  | ID of the channel where the message is posted.                                                                                        |
| **success**      | Boolean | `true` on success, `false` on failure.                                                                                                |
| **errorMessage** | String  | Failure reason as message. `null` on success.                                                                                         |

