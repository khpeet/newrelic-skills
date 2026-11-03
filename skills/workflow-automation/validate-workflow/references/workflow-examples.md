---
title: Workflow examples overview
source: https://docs.newrelic.com/docs/workflow-automation/workflow-examples/workflow-examples
---

Common automation scenarios for Workflow Automation, progressing from basic to advanced patterns. Use as starting points or explore the [template library](https://docs.newrelic.com/docs/workflow-automation/create-a-workflow-automation/use-a-template) for ready-to-deploy solutions.

## Available template workflows

Access templates directly in New Relic Workflow Automation UI:

1.  Go to **All Capabilities > Workflow Automation**
2.  Click **Create workflow**
3.  Select **Use a template**
4.  Browse the template library and choose a workflow matching your use case

Templates include:

-   Pre-configured workflow steps and logic
-   Example input parameters
-   Required credentials and integrations
-   Documentation of expected outcomes

Use templates as-is or customize to fit specific requirements.

## Workflow examples by complexity

### Basic patterns

Foundational examples demonstrating workflow operations and data passing between steps.

| Example                                                                                                                    | Description                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [HTTP GET and POST](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/http-get-post)     | Fetch data from REST APIs and send data to external systems     |
| [JSON parsing](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/json-parsing)           | Parse JSON responses using selectors to extract specific fields |
| [Workflow inputs](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/workflow-inputs)     | Pass dynamic values at runtime using workflow inputs            |
| [Data passing](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/data-passing)           | Reference outputs from previous steps to chain actions          |
| [Loops](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/loops)                         | Iterate through lists, maps, or collections                     |
| [Conditional logic](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/basic-patterns/conditional-logic) | Use switch statements for decision making                       |

### Common integrations

Integrate workflows with popular services like Slack, AWS, and REST APIs.

| Integration                                                                                                                 | Description                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Send reports to Slack](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/integrations/slack)            | Execute NRQL queries, convert to CSV, and post to Slack                                         |
| [AWS SQS messaging](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/integrations/aws-sqs)              | Send messages to SQS queues using IAM role authentication                                       |
| [REST API polling](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/integrations/rest-api-polling)      | Poll external APIs, loop through results, and log to New Relic                                  |
| [Alert RCA with Autopilot](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/integrations/autopilot-rca) | Trigger Autopilot to investigate an alert and deliver the root cause analysis to Slack or email |

### Advanced workflows

Complex, production-ready automation for infrastructure management and incident response.

| Workflow                                                                                                                       | Description                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [Complex NRQL alerting](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/advanced/nrql-alerting)           | Compare NRQL results across time windows to detect anomalies         |
| [Deployment rollback](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/advanced/deployment-rollback)       | Monitor entity health and trigger rollback notifications             |
| [EC2 instance management](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/advanced/ec2-management)        | Respond to CPU alerts and automate EC2 instance resizing             |
| [API gateway rollback](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/advanced/api-gateway-rollback)     | Detect deployments and automate API Gateway rollback                 |
| [Human-in-the-loop workflows](https://docs.newrelic.com/docs/workflow-automation/workflow-examples/advanced/human-in-the-loop) | Pause a workflow for human approval using signal URLs and wait steps |

## Related topics [#related-topics]

[Troubleshooting](https://docs.newrelic.com/docs/workflow-automation/troubleshooting)

Debug issues when implementing examples

[Workflow best practices](https://docs.newrelic.com/docs/workflow-automation/limitations-and-faq/workflow-best-practices)

Apply best practices from examples to your workflows
