---
title: AWS EC2 actions
source: https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/aws/ec2/aws-ec2
---

This page provides a reference for AWS EC2 actions available in the workflow automation actions catalog. Use these actions to manage EC2 instances, EBS volumes and snapshots, Elastic IP addresses, Amazon Machine Images (AMIs), security groups, key pairs, and EC2 resource tags.

## Prerequisites

Before using AWS actions in workflow automation, ensure you have:

-   An AWS account with appropriate permissions.
-   AWS credentials configured (IAM user credentials, IAM role ARN, or session credentials).
-   The necessary IAM permissions for the specific AWS services you plan to use.

See [Set up AWS credentials](https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/set-up-aws-credentials/) for information on how to create IAM users and IAM roles, and set up static and session AWS credentials for integration with workflow automation AWS actions.

## Run instances

The action identifier is `aws.ec2.runInstances`.

Launches the specified number of instances using an AMI for which you have permissions. If you don't specify a subnet ID, the default VPC subnet is used. If any AMIs have a product code the user hasn't subscribed to, the request fails.

The following table describes the input fields for this action.

| **Input**            | **Type** | **Description**                                                             | **Example**                                                                                                                         |
| -------------------- | -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `awsRoleArn`         | String   | Optional. IAM role ARN to assume for AWS API calls.                         | `arn:aws:iam::123456789012:role/my-workflow-role`                                                                                   |
| `awsAccessKeyId`     | String   | Optional. AWS access key ID. Pass as a secret.                              | `${{ :secrets:awsAccessKeyId }}`                                                                                                    |
| `awsSecretAccessKey` | String   | Optional. AWS secret access key. Pass as a secret.                          | `${{ :secrets:awsSecretAccessKey }}`                                                                                                |
| `awsSessionToken`    | String   | Optional. Temporary session token for STS authentication. Pass as a secret. | `${{ :secrets:awsSessionToken }}`                                                                                                   |
| `region`             | String   | Required. AWS region where the instances will be launched.                  | `us-east-2`                                                                                                                         |
| `imageId`            | String   | Required. The ID of the AMI to use for the instance.                        | `ami-0ca4d5db4872d0c28`                                                                                                             |
| `instanceType`       | String   | Required. The instance type to use for the instance.                        | `t2.micro`                                                                                                                          |
| `minCount`           | Int      | Required. Minimum number of instances to launch.                            | `1`                                                                                                                                 |
| `maxCount`           | Int      | Required. Maximum number of instances to launch.                            | `10`                                                                                                                                |
| `parameters`         | Map      | Optional. Additional boto3 API parameters for the run_instances call.       | `{"EbsOptimized": false, "TagSpecifications": [{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": "My-Web-Server"}]}]}` |
| `selectors`          | List     | Optional. JQ selectors to extract specific fields from the action output.   | `[{"name": "response", "expression": ".response"}]`                                                                                 |

> #### 💡 TIP
>
> The `parameters` map accepts any optional argument available in the boto3 API, allowing you to dynamically construct requests.

The following table describes the output fields for this action.

| **Output**     | **Type** | **Example**                                                                                                                                        |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response`     | Object   | See the [run_instances boto3 reference](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/ec2/client/run_instances.html). |
| `success`      | Boolean  | `true` or `false`                                                                                                                                  |
| `errorMessage` | String   | `""`                                                                                                                                               |

## Describe an instance

The action identifier is `aws.ec2.describeInstances`.

Describes the specified instances or all instances.

The following table describes the input fields for this action.

| **Input**            | **Type** | **Description**                                                             | **Example**                                                |
| -------------------- | -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `awsRoleArn`         | String   | Optional. IAM role ARN to assume for AWS API calls.                         | `arn:aws:iam::123456789012:role/my-workflow-role`          |
| `awsAccessKeyId`     | String   | Optional. AWS access key ID. Pass as a secret.                              | `${{ :secrets:awsAccessKeyId }}`                           |
| `awsSecretAccessKey` | String   | Optional. AWS secret access key. Pass as a secret.                          | `${{ :secrets:awsSecretAccessKey }}`                       |
| `awsSessionToken`    | String   | Optional. Temporary session token for STS authentication. Pass as a secret. | `${{ :secrets:awsSessionToken }}`                          |
| `region`             | String   | Required. AWS region where the instances are located.                       | `us-east-2`                                                |
| `instanceIds`        | List     | Optional. List of instance IDs to describe.                                 | `["i-0123456789abcdef0", "i-0fedcba9876543210"]`           |
| `filters`            | List     | Optional. Filters to apply to the describe request.                         | `[{"Name": "instance-state-name", "Values": ["running"]}]` |
| `nextToken`          | String   | Optional. Pagination token from a previous response.                        | `abcdefgh`                                                 |
| `maxResults`         | Int      | Optional. Maximum number of results to return.                              | `100`                                                      |
| `selectors`          | List     | Optional. JQ selectors to extract specific fields from the action output.   | `[{"name": "response", "expression": ".response"}]`        |

The following table describes the output fields for this action.

| **Output**     | **Type** | **Example**                                                                                                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `response`     | Object   | See the [describe_instances boto3 reference](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/ec2/client/describe_instances.html). |
| `success`      | Boolean  | `true` or `false`                                                                                                                                            |
| `errorMessage` | String   | `"The parameter instancesSet cannot be used with the parameter maxResults"`                                                                                  |

> #### ⚠️ IMPORTANT
>
> If you specify instance IDs, the output includes information for only the specified instances. If you specify filters, the output includes information for only those instances that meet the filter criteria. If you specify neither, the output includes information for all instances. The `instanceIds` parameter cannot be used together with `maxResults`.

## Restart instances

The action identifier is `aws.ec2.startInstances`.

Starts an Amazon EBS-backed instance that you previously stopped.

The following table describes the input fields for this action.

| **Input**            | **Type** | **Description**                                                             | **Example**                                         |
| -------------------- | -------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| `awsRoleArn`         | String   | Optional. IAM role ARN to assume for AWS API calls.                         | `arn:aws:iam::123456789012:role/my-workflow-role`   |
| `awsAccessKeyId`     | String   | Optional. AWS access key ID. Pass as a secret.                              | `${{ :secrets:awsAccessKeyId }}`                    |
| `awsSecretAccessKey` | String   | Optional. AWS secret access key. Pass as a secret.                          | `${{ :secrets:awsSecretAccessKey }}`                |
| `awsSessionToken`    | String   | Optional. Temporary session token for STS authentication. Pass as a secret. | `${{ :secrets:awsSessionToken }}`                   |
| `region`             | String   | Required. AWS region where the instances are located.                       | `us-east-2`                                         |
| `instanceIds`        | List     | Required. List of instance IDs to start.                                    | `["i-0123456789abcdef0", "i-0fedcba9876543210"]`    |
| `selectors`          | List     | Optional. JQ selectors to extract specific fields from the action output.   | `[{"name": "response", "expression": ".response"}]` |

The following table describes the output fields for this action.

| **Output**     | **Type** | **Example**                                                                                                                                            |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `response`     | Object   | See the [start_instances boto3 reference](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/ec2/client/start_instances.html). |
| `success`      | Boolean  | `true` or `false`                                                                                                                                      |
| `errorMessage` | String   | `"The parameter instancesSet cannot be used with the parameter maxResults"`                                                                            |

## Stop instances

The action identifier is `aws.ec2.stopInstances`.

Stops an Amazon EBS-backed instance.

The following table describes the input fields for this action.

| **Input**            | **Type** | **Description**                                                             | **Example**                                         |
| -------------------- | -------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| `awsRoleArn`         | String   | Optional. IAM role ARN to assume for AWS API calls.                         | `arn:aws:iam::123456789012:role/my-workflow-role`   |
| `awsAccessKeyId`     | String   | Optional. AWS access key ID. Pass as a secret.                              | `${{ :secrets:awsAccessKeyId }}`                    |
| `awsSecretAccessKey` | String   | Optional. AWS secret access key. Pass as a secret.                          | `${{ :secrets:awsSecretAccessKey }}`                |
| `awsSessionToken`    | String   | Optional. Temporary session token for STS authentication. Pass as a secret. | `${{ :secrets:awsSessionToken }}`                   |
| `region`             | String   | Required. AWS region where the instances are located.                       | `us-east-2`                                         |
| `instanceIds`        | List     | Required. List of instance IDs to stop.                                     | `["i-0123456789abcdef0", "i-0fedcba9876543210"]`    |
| `hibernate`          | Boolean  | Optional. Hibernate the instance instead of stopping it. Default: `false`.  | `false`                                             |
| `force`              | Boolean  | Optional. Force stop the instance. Default: `false`.                        | `false`                                             |
| `selectors`          | List     | Optional. JQ selectors to extract specific fields from the action output.   | `[{"name": "response", "expression": ".response"}]` |

The following table describes the output fields for this action.

| **Output**     | **Type** | **Example**                                                                                                                                          |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response`     | Object   | See the [stop_instances boto3 reference](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/ec2/client/stop_instances.html). |
| `success`      | Boolean  | `true` or `false`                                                                                                                                    |
| `errorMessage` | String   | `"An error occurred (InvalidInstanceID.Malformed) when calling the StopInstances operation: The instance ID 'i-123456789' is malformed"`             |

