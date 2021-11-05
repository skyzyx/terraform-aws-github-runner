# Terraform module for scalable self hosted GitHub action runners <!-- omit in toc -->

[![awesome-runners](https://img.shields.io/badge/listed%20on-awesome--runners-blue.svg)](https://github.com/jonico/awesome-runners)[![Terraform registry](https://img.shields.io/github/v/release/philips-labs/terraform-aws-github-runner?label=Terraform%20Registry)](https://registry.terraform.io/modules/philips-labs/github-runner/aws/) ![Terraform checks](https://github.com/philips-labs/terraform-aws-github-runner/workflows/Terraform%20root%20module%20checks/badge.svg) ![Lambda Webhook](https://github.com/philips-labs/terraform-aws-github-runner/workflows/Lambda%20Agent%20Webhook/badge.svg) ![Lambda Runners](https://github.com/philips-labs/terraform-aws-github-runner/workflows/Lambda%20Runners/badge.svg) ![Lambda Syncer](https://github.com/philips-labs/terraform-aws-github-runner/workflows/Lambda%20Runner%20Binaries%20Syncer/badge.svg)

This [Terraform](https://www.terraform.io/) module creates the required infrastructure needed to host [GitHub Actions](https://github.com/features/actions) self-hosted, autoscaling runners on [AWS spot instances](https://aws.amazon.com/ec2/spot/). It provides the required logic to handle the lifecycle for scaling-up and down using a set of AWS Lambda functions. Runners are scaled-down to zero to avoid costs when no workflows are active.

> **NOTE:** Click the _list_ icon to the left of "README.md" for the table of contents.

## Motivation

GitHub Actions `self-hosted` runners provide a flexible option to run CI workloads on infrastructure of your choice. Currently there is no option provided to automate the creation and scaling of action runners. This module takes care of creating the AWS infrastructure to host action runners on spot instances. It provides Lambda functions to orchestrate the lifecycle of the action runners.

Lambda was chosen as runtime for two major reasons. First, it allows to create small components with minimal access to AWS and GitHub. Secondly, it provides a scalable setup with minimal costs that works on the repository level and scales to the organization level. The Lambda functions will create Linux-based EC2 instances with Docker to serve CI workloads that can run on Linux and/or Docker. The main goal is to support Docker-based workloads.

A logical question would be why not Kubernetes? In the current approach, we stay close to the way the GitHub Actions runners are available today. The approach is to install the runner on a host where the required software is available. With this setup we stay quite close to the current GitHub approach. Another logical choice would be AWS Autoscaling Groups. This choice would typically require more permissions at the instance level to communicate with GitHub. Scaling up and down is not trivial.

## Overview

### Events and Scaling-Up

When a GitHub Actions workflow (requiring a `self-hosted` runner) is triggered, GitHub will try to find a runner which can execute the workload. This module reacts to GitHub's [`check_run` event](https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#check_run) or [`workflow_job` event](https://docs.github.com/en/free-pro-team@latest/developers/webhooks-and-events/webhook-events-and-payloads#workflow_job) for the triggered workflow and creates a new runner if necessary.

For receiving the `check_run` or `workflow_job` event by the webhook (Lambda fronted by API Gateway), a webhook reference in GitHub needs to be created. The `workflow_job` is the preferred option and the `check_run` option will be maintained for backward compatibility. (As of this writing, GitHub Enterprise Server v3.2 only supports `check_run`.) The advantage of the `workflow_job` event is that the runner checks if the received event can run on the configured runners by matching the labels, which avoid instances are scaled up and never used. The following options are available:

- `workflow_job`: **(preferred option)** create a webhook on enterprise, org or app level.

- `check_run`: create a webhook on enterprise, org, repo or app level. When using the app option, the app needs to be installed to repo's are using the self-hosted runners.

-  A webhook needs to be created. The webhook _hook_ can be defined on the enterprise, org, repo, or GitHub App level.

### Receiving the Event

In AWS, an [API Gateway](https://docs.aws.amazon.com/apigateway/index.html) endpoint is created that is able to receive the GitHub webhook events via HTTP post. The gateway triggers the webhook lambda which will verify the signature of the event. This check guarantees the event is sent by the GitHub App. The Lambda only handles `workflow_job` or `check_run` events with status `queued` and matching the runner labels (only for `workflow_job`). The accepted events are posted to an SQS queue. Messages on this queue will be delayed for a configurable amount of seconds (default 30 seconds) to give the available runners time to pick up this build.

The "scale-up runner" Lambda function listens to the SQS queue and picks up events. The Lambda function runs various checks to decide whether or not a new EC2 instance needs to be created. For example, the instance is not created if the build has already been picked-up by an existing runner, or the maximum number of runners has been reached.

### Registering the Runner

The Lambda function first requests a registration token from GitHub which is needed by the runner to register itself with GitHub Actions. This ensures that the EC2 instance will not need admin permissions to install the _Runners Agent_ and register itself. Next the EC2 instance is created via a Launch Template. The Launch Template defines the configuration for the instances, and contains [`user_data`](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html) which will install and configure the required software. The registration token for the Actions runner is stored in Parameter Store (part of AWS SSM), and the `user_data` will fetch, use, and delete it. Once finished, the Actions runner should be online and the workflow should start in seconds.

### Scaling-Down

Scaling-down the runners is brute-forced at the moment. Periodically, a Lambda function will check every runner instance to see if it’s busy. If a runner is not busy, it will be de-registered from GitHub Actions and the instance will be terminated. At the moment, there seems no other option to scale-down more smoothly.

### Downloading the _Runners Agent_

Downloading the GitHub Actions Runner distribution can occasionally be slow (more than 10 minutes). To address this, a Lambda function synchronizes the _Runners Agent_ from GitHub to an S3 bucket. The EC2 instance will fetch the distribution from the S3 bucket instead of the internet. Secrets and private keys are stored in Parameter Store and are encrypted either by using the default KMS key for SSM, or passing-in a custom KMS key.

## Architecture Diagram

![Architecture](docs/component-overview.svg)

### Permissions

Permission are managed in several places. Below are the most important ones. For details, check the Terraform source.

- The GitHub App requires access to actions and publish `workflow_job` events to the webhook (API Gateway).
- The scale-up Lambda function should have access to EC2 for creating and tagging instances.
- The scale-down Lambda function should have access to EC2 to terminate instances.
- Besides these permissions, the lambdas also need permission to CloudWatch (for logging and scheduling), SSM and S3. For more details about the required permissions see the [documentation](./modules/setup-iam-permissions/README.md) of the IAM module which uses permission boundaries.

When running inside of a VPC, you'll need to pay attention to how your public and private subnets are configured. AWS Lambda will need to be able to communicate with both GitHub.com (or GitHub Enterprise Server) as well as the EC2 and SSM APIs. These are not part of this Terraform module, as different AWS accounts will have different requirements. But this is something to pay attention to, and address on your own (e.g., Terraform, CloudFormation, Control Tower, via the Console UI).

### ARM64 support via Graviton/Graviton2 instance-types

When using the default example or top-level module, specifying an `instance_type` that matches a Graviton/Graviton 2 (ARM64) architecture (e.g., `a1` or any 6th-gen `g` or `gd` type), the sub-modules will be automatically configured to provision with ARM64 AMIs and leverage GitHub’s ARM64 action runner. See below for more details.

## Usage

Examples are provided in [the example directory](examples/). Please ensure you have installed the following tools.

- Terraform, [tfenv](https://github.com/tfutils/tfenv), or [tfswitch](https://tfswitch.warrensbox.com)
- Bash shell
- Docker (optional, to build Lambda functions without Node.js installed locally)
- AWS CLI (optional)
- Node.js and `yarn` (for Lambda development)

The module supports three main scenarios for creating runners.

* **Repository-level:** A runner will be dedicated to only one repository. No other repository can use the runner.

* **Organization-level:** You can use the runner(s) for all of the repositories within the organization.

* **Enterprise-level:** [Only GitHub Enterprise Server] You can use the set of runners for all orgs and repos within your installation. However, the GitHub app you create (below) will need to be _installed_ by each organization’s administrator.

See “[About self-hosted runners](https://help.github.com/en/actions/hosting-your-own-runners/about-self-hosted-runners)” for more information.

### Caveats

GitHub workflows will fail _immediately_ if there is no Actions runner available for your builds. Since this module supports scaling-down to zero runners, builds will fail when there is no active runner available. We recommend creating an _offline_ runner with labels which match the _scalable_ configuration. You can create this runner manually by following “[About self-hosted runners](https://help.github.com/en/actions/hosting-your-own-runners/about-self-hosted-runners)”. (We are currently evaluating automation options — [#519](https://github.com/philips-labs/terraform-aws-github-runner/issues/519)).

<details>
  <summary>Temporary runner using Docker</summary>

  Another convenient way of deploying this temporary required runner is using following approach. This automates all the manual labor.

  ```bash
  docker run -it --name my-runner \
      -e RUNNER_LABELS=selfhosted,Linux,Ubuntu -e RUNNER_NAME=my-repo-docker-runner \
      -e GITHUB_ACCESS_TOKEN=$GH_PERSONAL_ACCESS_TOKEN \
      -e RUNNER_REPOSITORY_URL=https://github.com/my-org/my-repo \
      -v /var/run/docker.sock:/var/run/docker.sock \
      tcardonne/github-runner:ubuntu-20.04
  ```

  You should stop and remove the container once the runner is registered as the builds would otherwise go to your local Docker container.

  The setup consists of running Terraform to create all AWS resources and manually configuring the GitHub App. The Terraform module requires configuration from the GitHub App and the GitHub app requires output from Terraform. Therefore you first create the GitHub App and configure the basics, then run Terraform, and afterwards finalize the configuration of the GitHub App.
  
</details>

## Setting up the GitHub App and AWS Infrastructue

### Stage 1: Setting up the GitHub App

Go to GitHub and [create a new app](https://docs.github.com/en/developers/apps/creating-a-github-app).

> **NOTE:** You have the option to create apps for your **organization** or for a **user**.

1. Create a new GitHub app. Choose a name, and give it an app URL (required by GitHub/GHES; not used by the module).

1. Enable the webhook. For now, enter a bogus endpoint (we will update this later). Since event data _may_ flow to this URL, use a domain that you have control over so that the POST payload doesn't end up in someone else's logs. (Your cybersecurity team would consider this _information leakage_.)

1. You will also need to generate a webhook _secret_. It could be a random hash, a random string, something from a password generator, but the important thing is the _randomness_. Randomness makes things harder to guess, and the human brain is really bad at random.

1. Permissions for **all** runners:
    * Repository:
      * `Actions`: Read-only (check for queued jobs)
      * `Checks`: Read-only (receive events for new builds)
      * `Metadata`: Read-only (default/required)

1. Permissions for **repo-level** runners only:
   * Repository:
     * `Administration`: Read & write (to register runner)

1. Permissions for **organization-level** runners only:
   * Organization
     * `Self-hosted runners`: Read & write (to register runner)

1. Save the app. This will generate an _App ID_, _Client ID_, and _Client Secret_.

1. It should also generate an RSA private key for you. You'll need this to authenticate, and it's not retrievable without creating a whole new one. Keep it safe.

### Stage 2: Running Terraform

1. If you're familiar with Terraform and Terraform modules, you'll know that you need to write your `main.tf` which _calls_ your Terraform module. You pass values to variables defined by that module, and if you want the module outputs to be available to you, you will need to expose them as `output` blocks in your `main.tf`.

1. Another thing to remember is that Terraform will _automatically load_ any variables from `*.auto.tfvars` files. This means that you can write a little code to lookup networking values from AWS and save them as a standalone file (e.g., `networking.auto.tfvars`). This is also a good tip for keeping _secrets_ out of your Git repository. Put your secrets in a file that is `.gitignore`’d, and shared from a central place that the appropriate people have access to.

In this example, we are using a file structure which looks something like this:

```plain
.
├── bin
│   └── build-lambdas.sh
└── terraform
    ├── 01-service-linked-role
    │   ├── main.tf
    │   └── ...
    └── 02-standup-infrastructure
        ├── main.tf
        └── ...
```

#### Service-Linked Role (One-Time Operation!)

To create spot instances, the `AWSServiceRoleForEC2Spot` role needs to be added to your account. First, determine whether or not this even needs to be created.

```bash
aws iam list-roles --path-prefix /aws-service-role/spot.amazonaws.com/ \
  | jq '.Roles | length'
```

| Result | Meaning                                                      |
|--------|--------------------------------------------------------------|
| `1`    | The role already exists. Skip ahead to the next instruction. |
| `0`    | You need to create the role.                                 |


To use Terraform for creating the role, set this up as **separate** Terraform with a **separate** state file. (Using the file structure above, this is `{root}/terraform/01-service-linked-role`.)


```hcl
resource "aws_iam_service_linked_role" "spot" {
  aws_service_name = "spot.amazonaws.com"
}
```

#### Pre-Compiling Lambda Functions

In this example, this file lives in the filesystem at `{root}/bin/build-lambdas.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Discover the root directory of the repository, whereas $ROOT_DIR/bin/build-lambdas.sh is this very file.
ROOT_DIR="$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")"
echo "ROOT_DIR=${ROOT_DIR}"

# Touch
mkdir -p /tmp/aws-github-runner
rm -Rf /tmp/aws-github-runner

# Fetch
git clone --branch "$git_tag" --depth 1 git@github.com:philips-labs/terraform-aws-github-runner.git /tmp/aws-github-runner

# Build Lambda functions
cd /tmp/aws-github-runner
.ci/build.sh

# Copy into the Terraform directory
cp -rvf /tmp/aws-github-runner/lambda_output "${ROOT_DIR}/terraform/02-standup-infrastructure/lambda_output"

# Clean up after ourselves
rm -Rf /tmp/aws-github-runner
```

#### Applying the Terraform Module

Create a second Terraform workspace (not to be confused with _Terraform Workspaces_) or adapt one of the [examples](./examples). (Using the file structure above, this is `{root}/terraform/02-standup-infrastructure`.)

Note that `github_runner.key_base64` needs to be Base64-encoded — that is, the output of `base64(app.private-key.pem)`, not the content of `app.private-key.pem`.

```terraform
module "github_runner" {
  source  = "philips-labs/github-runner/aws"
  version = "REPLACE_WITH_VERSION"

  aws_region = "eu-west-1"
  vpc_id     = "vpc-123"
  subnet_ids = ["subnet-123", "subnet-456"]

  environment = "gh-ci"

  github_app = {
    key_base64     = "base64string"
    id             = "1"
    webhook_secret = "webhook_secret"
  }

  webhook_lambda_zip                = "lambda_output/webhook.zip"
  runner_binaries_syncer_lambda_zip = "lambda_output/runner-binaries-syncer.zip"
  runners_lambda_zip                = "lambda_output/runners.zip"
  enable_organization_runners       = true
}
```

We also want to expose the outputs from the module to the outer scope where our own `main.tf` lives, so that we can access them with `terraform output`.

```terraform
output "webhook_endpoint" {
  description = "The URL of the API Gateway that we'll use as a webhook."
  value       = module.gha_runner.webhook.endpoint
}
```

> **NOTE:** For `ARM64` support, specify an `a1` or `*6g*` (6th-gen Graviton2) instance type to stand up an ARM64 runner, otherwise the default is `x86_64`.

Run Terraform by using the following commands. (This assumes that your AWS credentials are available in your terminal session.)

1. Initialize Terraform.

    ```bash
    terraform init
    ```

1. Generate a _plan_, and then review it so that you understand what's being created.

    ```bash
    terraform plan -out tfplan
    ```

1. Apply the plan, ensuring that what you reviewed is what will happen.

    ```bash
    terraform apply tfplan
    ```

1. Clean up after ourselves.

    ```bash
    rm -f tfplan
    ```

The output will display the API Gateway URL (endpoint), which you need in the next step.

### Stage 3: Configure the Webhook

1. Edit the GitHub App that we created in _Stage 1_. Take the webhook URL, and replace the bogus one with the one that we generated from Terraform.

1. In the _Permissions and Events_ section of the GitHub App, under _Subscribe to Events_, check _Workflow Job_ (if available) or _Check Run_.

  > **IMPORTANT:** Only choose one!

#### Install app

In the _Install App_ section of the GitHub App, install the app into an organization where are an adminstrator, then select which repositories should have access to it. Every organization that wants to use these runners MUST install the GitHub App you created in _Stage 1_. Only org admins can perform an app installation.
 
Remember that **builds will fail** if there is no (offline) runner available with matching labels.

### Encryption

The module support two scenarios to manage environment secrets and private key of the Lambda functions.

#### Encrypted via a Managed KMS Key (Default)

This is the default option. No additional configuration is required.

#### Encrypted via a Customer-Provided KMS Key

You will need to create an configure your own KMS key (known as a _Customer-Provided KMS Key_ or sometimes _Customer-Managed KMS Key_). The module will use the context with key: `Environment` and value `var.environment` as encryption context.

```hcl
resource "aws_kms_key" "github" {
  is_enabled = true
}

module "runners" {
  kms_key_arn = aws_kms_key.github.arn
  # ...
}
```

### Idle Runners

The module will scale-down to zero runners by default. Specifying an `idle_config` configuration will enable idle runners to be kept active.

The scale-down Lambda function checks to see if any cron expressions match the current time (within a margin of 5 seconds). When matched, the number of runners specified in the `idle_config` will be kept active. In case there are  multiple matches, only the first one is acted-upon. Below is an `idle_config` for keeping runners active from 9am–5pm, Monday–Friday.

```hcl
idle_config = [{
   cron      = "* * 9-17 * * 1-5"
   timeZone  = "Europe/Amsterdam"
   idleCount = 2
}]
```

#### Cron Syntax

Cron expressions are parsed by [cron-parser](https://github.com/harrisiirak/cron-parser#readme). The supported syntax is as follows:

```plain
*    *    *    *    *    *
┬    ┬    ┬    ┬    ┬    ┬
│    │    │    │    │    |
│    │    │    │    │    └ day of week (0 - 7) (0 or 7 is Sun)
│    │    │    │    └───── month (1 - 12)
│    │    │    └────────── day of month (1 - 31)
│    │    └─────────────── hour (0 - 23)
│    └──────────────────── minute (0 - 59)
└───────────────────────── second (0 - 59, optional)
```

For timezones, please check [TZ database name column](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) for the supported values.

## Examples

Examples are located in the [examples](./examples) directory. The following examples are provided:

* _[Default](examples/default/README.md)_: The default example of the module
* _[Permissions boundary](examples/permissions-boundary/README.md)_: Example usages of permissions boundaries.

## Submodules

The module contains several submodules, you can use the module via the main module or assemble your own setup by initializing the submodules yourself.

The following submodules are the core of the module and are mandatory:

* _[runner-binaries-syncer](./modules/runner-binaries-syncer/README.md)_ - Fetches the _Runner Agent_ from GitHub and stores it in Amazon S3.
* _[runners](./modules/runners/README.md)_ - Provides the scale-up and scale-down Lambda functions.
* _[webhook](./modules/webhook/README.md)_ - Handles GitHub Event webhooks.

The following sub modules are optional and are provided as example or utility:

* _[download-lambda](./modules/download-lambda/README.md)_ - Download Lambda artifacts from the GitHub release page.
* _[setup-iam-permissions](./modules/setup-iam-permissions/README.md)_ - Setup IAM permission boundaries.

### ARM64 Configuration for Submodules

When not using the top-level module and specifying an `a1` or `*6g*` (6th-gen Graviton2) `instance_type`, the `runner-binaries-syncer` and `runners` submodules need to be configured appropriately for pulling the ARM64 GitHub Actions _Runner Agent_ and leveraging the ARM64 AMI for the runners.

When configuring `runner-binaries-syncer`:

* _runner_architecture_ - Set to `arm64`. The default value is `x64`.

When configuring `runners`:

* _ami_filter_ - Set to `["amzn2-ami-hvm-2*-arm64-gp2"]`. The default value is `["amzn2-ami-hvm-2.*-x86_64-ebs"]`.

## Debugging

In case the setup does not work as intended follow the trace of events:

1. In the GitHub App configuration, the _Advanced_ page displays all webhook events that were sent.

1. In AWS CloudWatch Logs, every Lambda function has a log group. Look at the logs of the `webhook` and `scale-up` Lambda functions.

1. In AWS SQS you can see messages available or in flight.

1. Once an EC2 instance is running, you can connect to it in the EC2 user interface using _Session Manager_. Check the `user_data` script using `cat /var/log/user-data.log`.

  1. Several log files from the instances are streamed to AWS CloudWatch Logs.

  1. Look for a log group named `<environment>/runners`.

  1. In the log group you should see at least the log streams for the `user_data` installation and runner agent.

1. Registered instances should show up in the _Settings_ → _Actions_ page of the repository or organization (depending on the installation mode).

<!-- BEGINNING OF PRE-COMMIT-TERRAFORM DOCS HOOK -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 0.14.1 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 3.38 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | >= 3.38 |
| <a name="provider_random"></a> [random](#provider\_random) | n/a |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_runner_binaries"></a> [runner\_binaries](#module\_runner\_binaries) | ./modules/runner-binaries-syncer | n/a |
| <a name="module_runners"></a> [runners](#module\_runners) | ./modules/runners | n/a |
| <a name="module_ssm"></a> [ssm](#module\_ssm) | ./modules/ssm | n/a |
| <a name="module_webhook"></a> [webhook](#module\_webhook) | ./modules/webhook | n/a |

## Resources

| Name | Type |
|------|------|
| [aws_resourcegroups_group.resourcegroups_group](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/resourcegroups_group) | resource |
| [aws_sqs_queue.queued_builds](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue) | resource |
| [random_string.random](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/string) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_ami_filter"></a> [ami\_filter](#input\_ami\_filter) | List of maps used to create the AMI filter for the action runner AMI. By default amazon linux 2 is used. | `map(list(string))` | `{}` | no |
| <a name="input_ami_owners"></a> [ami\_owners](#input\_ami\_owners) | The list of owners used to select the AMI of action runner instances. | `list(string)` | <pre>[<br>  "amazon"<br>]</pre> | no |
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region. | `string` | n/a | yes |
| <a name="input_block_device_mappings"></a> [block\_device\_mappings](#input\_block\_device\_mappings) | The EC2 instance block device configuration. Takes the following keys: `device_name`, `delete_on_termination`, `volume_type`, `volume_size`, `encrypted`, `iops` | `map(string)` | `{}` | no |
| <a name="input_cloudwatch_config"></a> [cloudwatch\_config](#input\_cloudwatch\_config) | (optional) Replaces the module default cloudwatch log config. See https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html for details. | `string` | `null` | no |
| <a name="input_create_service_linked_role_spot"></a> [create\_service\_linked\_role\_spot](#input\_create\_service\_linked\_role\_spot) | (optional) create the serviced linked role for spot instances that is required by the scale-up lambda. | `bool` | `false` | no |
| <a name="input_delay_webhook_event"></a> [delay\_webhook\_event](#input\_delay\_webhook\_event) | The number of seconds the event accepted by the webhook is invisible on the queue before the scale up lambda will receive the event. | `number` | `30` | no |
| <a name="input_disable_check_wokflow_job_labels"></a> [disable\_check\_wokflow\_job\_labels](#input\_disable\_check\_wokflow\_job\_labels) | Disable the the check of workflow labels for received workflow job events. | `bool` | `false` | no |
| <a name="input_enable_cloudwatch_agent"></a> [enable\_cloudwatch\_agent](#input\_enable\_cloudwatch\_agent) | Enabling the cloudwatch agent on the ec2 runner instances, the runner contains default config. Configuration can be overridden via `cloudwatch_config`. | `bool` | `true` | no |
| <a name="input_enable_organization_runners"></a> [enable\_organization\_runners](#input\_enable\_organization\_runners) | Register runners to organization, instead of repo level | `bool` | `false` | no |
| <a name="input_enable_ssm_on_runners"></a> [enable\_ssm\_on\_runners](#input\_enable\_ssm\_on\_runners) | Enable to allow access the runner instances for debugging purposes via SSM. Note that this adds additional permissions to the runner instances. | `bool` | `false` | no |
| <a name="input_environment"></a> [environment](#input\_environment) | A name that identifies the environment, used as prefix and for tagging. | `string` | n/a | yes |
| <a name="input_ghes_ssl_verify"></a> [ghes\_ssl\_verify](#input\_ghes\_ssl\_verify) | GitHub Enterprise SSL verification. Set to 'false' when custom certificate (chains) is used for GitHub Enterprise Server (insecure). | `bool` | `true` | no |
| <a name="input_ghes_url"></a> [ghes\_url](#input\_ghes\_url) | GitHub Enterprise Server URL. Example: https://github.internal.co - DO NOT SET IF USING PUBLIC GITHUB | `string` | `null` | no |
| <a name="input_github_app"></a> [github\_app](#input\_github\_app) | GitHub app parameters, see your github app. Ensure the key is the base64-encoded `.pem` file (the output of `base64 app.private-key.pem`, not the content of `private-key.pem`). | <pre>object({<br>    key_base64     = string<br>    id             = string<br>    webhook_secret = string<br>  })</pre> | n/a | yes |
| <a name="input_idle_config"></a> [idle\_config](#input\_idle\_config) | List of time period that can be defined as cron expression to keep a minimum amount of runners active instead of scaling down to 0. By defining this list you can ensure that in time periods that match the cron expression within 5 seconds a runner is kept idle. | <pre>list(object({<br>    cron      = string<br>    timeZone  = string<br>    idleCount = number<br>  }))</pre> | `[]` | no |
| <a name="input_instance_profile_path"></a> [instance\_profile\_path](#input\_instance\_profile\_path) | The path that will be added to the instance\_profile, if not set the environment name will be used. | `string` | `null` | no |
| <a name="input_instance_type"></a> [instance\_type](#input\_instance\_type) | [DEPRECATED] See instance\_types. | `string` | `"m5.large"` | no |
| <a name="input_instance_types"></a> [instance\_types](#input\_instance\_types) | List of instance types for the action runner. | `list(string)` | `null` | no |
| <a name="input_job_queue_retention_in_seconds"></a> [job\_queue\_retention\_in\_seconds](#input\_job\_queue\_retention\_in\_seconds) | The number of seconds the job is held in the queue before it is purged | `number` | `86400` | no |
| <a name="input_key_name"></a> [key\_name](#input\_key\_name) | Key pair name | `string` | `null` | no |
| <a name="input_kms_key_arn"></a> [kms\_key\_arn](#input\_kms\_key\_arn) | Optional CMK Key ARN to be used for Parameter Store. This key must be in the current account. | `string` | `null` | no |
| <a name="input_lambda_s3_bucket"></a> [lambda\_s3\_bucket](#input\_lambda\_s3\_bucket) | S3 bucket from which to specify lambda functions. This is an alternative to providing local files directly. | `any` | `null` | no |
| <a name="input_lambda_security_group_ids"></a> [lambda\_security\_group\_ids](#input\_lambda\_security\_group\_ids) | List of security group IDs associated with the Lambda function. | `list(string)` | `[]` | no |
| <a name="input_lambda_subnet_ids"></a> [lambda\_subnet\_ids](#input\_lambda\_subnet\_ids) | List of subnets in which the action runners will be launched, the subnets needs to be subnets in the `vpc_id`. | `list(string)` | `[]` | no |
| <a name="input_log_level"></a> [log\_level](#input\_log\_level) | Logging level for lambda logging. Valid values are  'silly', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'. | `string` | `"info"` | no |
| <a name="input_log_type"></a> [log\_type](#input\_log\_type) | Logging format for lambda logging. Valid values are 'json', 'pretty', 'hidden'. | `string` | `"pretty"` | no |
| <a name="input_logging_retention_in_days"></a> [logging\_retention\_in\_days](#input\_logging\_retention\_in\_days) | Specifies the number of days you want to retain log events for the lambda log group. Possible values are: 0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, and 3653. | `number` | `180` | no |
| <a name="input_market_options"></a> [market\_options](#input\_market\_options) | Market options for the action runner instances. Setting the value to `null` let the scaler create on-demand instances instead of spot instances. | `string` | `"spot"` | no |
| <a name="input_minimum_running_time_in_minutes"></a> [minimum\_running\_time\_in\_minutes](#input\_minimum\_running\_time\_in\_minutes) | The time an ec2 action runner should be running at minimum before terminated if not busy. | `number` | `5` | no |
| <a name="input_repository_white_list"></a> [repository\_white\_list](#input\_repository\_white\_list) | List of repositories allowed to use the github app | `list(string)` | `[]` | no |
| <a name="input_role_path"></a> [role\_path](#input\_role\_path) | The path that will be added to role path for created roles, if not set the environment name will be used. | `string` | `null` | no |
| <a name="input_role_permissions_boundary"></a> [role\_permissions\_boundary](#input\_role\_permissions\_boundary) | Permissions boundary that will be added to the created roles. | `string` | `null` | no |
| <a name="input_runner_additional_security_group_ids"></a> [runner\_additional\_security\_group\_ids](#input\_runner\_additional\_security\_group\_ids) | (optional) List of additional security groups IDs to apply to the runner | `list(string)` | `[]` | no |
| <a name="input_runner_allow_prerelease_binaries"></a> [runner\_allow\_prerelease\_binaries](#input\_runner\_allow\_prerelease\_binaries) | Allow the runners to update to prerelease binaries. | `bool` | `false` | no |
| <a name="input_runner_as_root"></a> [runner\_as\_root](#input\_runner\_as\_root) | Run the action runner under the root user. | `bool` | `false` | no |
| <a name="input_runner_binaries_s3_sse_configuration"></a> [runner\_binaries\_s3\_sse\_configuration](#input\_runner\_binaries\_s3\_sse\_configuration) | Map containing server-side encryption configuration for runner-binaries S3 bucket. | `any` | `{}` | no |
| <a name="input_runner_binaries_syncer_lambda_timeout"></a> [runner\_binaries\_syncer\_lambda\_timeout](#input\_runner\_binaries\_syncer\_lambda\_timeout) | Time out of the binaries sync lambda in seconds. | `number` | `300` | no |
| <a name="input_runner_binaries_syncer_lambda_zip"></a> [runner\_binaries\_syncer\_lambda\_zip](#input\_runner\_binaries\_syncer\_lambda\_zip) | File location of the binaries sync lambda zip file. | `string` | `null` | no |
| <a name="input_runner_boot_time_in_minutes"></a> [runner\_boot\_time\_in\_minutes](#input\_runner\_boot\_time\_in\_minutes) | The minimum time for an EC2 runner to boot and register as a runner. | `number` | `5` | no |
| <a name="input_runner_ec2_tags"></a> [runner\_ec2\_tags](#input\_runner\_ec2\_tags) | Map of tags that will be added to the launch template instance tag specificatons. | `map(string)` | `{}` | no |
| <a name="input_runner_egress_rules"></a> [runner\_egress\_rules](#input\_runner\_egress\_rules) | List of egress rules for the GitHub runner instances. | <pre>list(object({<br>    cidr_blocks      = list(string)<br>    ipv6_cidr_blocks = list(string)<br>    prefix_list_ids  = list(string)<br>    from_port        = number<br>    protocol         = string<br>    security_groups  = list(string)<br>    self             = bool<br>    to_port          = number<br>    description      = string<br>  }))</pre> | <pre>[<br>  {<br>    "cidr_blocks": [<br>      "0.0.0.0/0"<br>    ],<br>    "description": null,<br>    "from_port": 0,<br>    "ipv6_cidr_blocks": [<br>      "::/0"<br>    ],<br>    "prefix_list_ids": null,<br>    "protocol": "-1",<br>    "security_groups": null,<br>    "self": null,<br>    "to_port": 0<br>  }<br>]</pre> | no |
| <a name="input_runner_extra_labels"></a> [runner\_extra\_labels](#input\_runner\_extra\_labels) | Extra labels for the runners (GitHub). Separate each label by a comma | `string` | `""` | no |
| <a name="input_runner_group_name"></a> [runner\_group\_name](#input\_runner\_group\_name) | Name of the runner group. | `string` | `"Default"` | no |
| <a name="input_runner_iam_role_managed_policy_arns"></a> [runner\_iam\_role\_managed\_policy\_arns](#input\_runner\_iam\_role\_managed\_policy\_arns) | Attach AWS or customer-managed IAM policies (by ARN) to the runner IAM role | `list(string)` | `[]` | no |
| <a name="input_runner_log_files"></a> [runner\_log\_files](#input\_runner\_log\_files) | (optional) Replaces the module default cloudwatch log config. See https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html for details. | <pre>list(object({<br>    log_group_name   = string<br>    prefix_log_group = bool<br>    file_path        = string<br>    log_stream_name  = string<br>  }))</pre> | <pre>[<br>  {<br>    "file_path": "/var/log/messages",<br>    "log_group_name": "messages",<br>    "log_stream_name": "{instance_id}",<br>    "prefix_log_group": true<br>  },<br>  {<br>    "file_path": "/var/log/user-data.log",<br>    "log_group_name": "user_data",<br>    "log_stream_name": "{instance_id}",<br>    "prefix_log_group": true<br>  },<br>  {<br>    "file_path": "/home/ec2-user/actions-runner/_diag/Runner_**.log",<br>    "log_group_name": "runner",<br>    "log_stream_name": "{instance_id}",<br>    "prefix_log_group": true<br>  }<br>]</pre> | no |
| <a name="input_runner_metadata_options"></a> [runner\_metadata\_options](#input\_runner\_metadata\_options) | Metadata options for the ec2 runner instances. | `map(any)` | <pre>{<br>  "http_endpoint": "enabled",<br>  "http_put_response_hop_limit": 1,<br>  "http_tokens": "optional"<br>}</pre> | no |
| <a name="input_runners_lambda_s3_key"></a> [runners\_lambda\_s3\_key](#input\_runners\_lambda\_s3\_key) | S3 key for runners lambda function. Required if using S3 bucket to specify lambdas. | `any` | `null` | no |
| <a name="input_runners_lambda_s3_object_version"></a> [runners\_lambda\_s3\_object\_version](#input\_runners\_lambda\_s3\_object\_version) | S3 object version for runners lambda function. Useful if S3 versioning is enabled on source bucket. | `any` | `null` | no |
| <a name="input_runners_lambda_zip"></a> [runners\_lambda\_zip](#input\_runners\_lambda\_zip) | File location of the lambda zip file for scaling runners. | `string` | `null` | no |
| <a name="input_runners_maximum_count"></a> [runners\_maximum\_count](#input\_runners\_maximum\_count) | The maximum number of runners that will be created. | `number` | `3` | no |
| <a name="input_runners_scale_down_lambda_timeout"></a> [runners\_scale\_down\_lambda\_timeout](#input\_runners\_scale\_down\_lambda\_timeout) | Time out for the scale down lambda in seconds. | `number` | `60` | no |
| <a name="input_runners_scale_up_lambda_timeout"></a> [runners\_scale\_up\_lambda\_timeout](#input\_runners\_scale\_up\_lambda\_timeout) | Time out for the scale up lambda in seconds. | `number` | `180` | no |
| <a name="input_scale_down_schedule_expression"></a> [scale\_down\_schedule\_expression](#input\_scale\_down\_schedule\_expression) | Scheduler expression to check every x for scale down. | `string` | `"cron(*/5 * * * ? *)"` | no |
| <a name="input_subnet_ids"></a> [subnet\_ids](#input\_subnet\_ids) | List of subnets in which the action runners will be launched, the subnets needs to be subnets in the `vpc_id`. | `list(string)` | n/a | yes |
| <a name="input_syncer_lambda_s3_key"></a> [syncer\_lambda\_s3\_key](#input\_syncer\_lambda\_s3\_key) | S3 key for syncer lambda function. Required if using S3 bucket to specify lambdas. | `any` | `null` | no |
| <a name="input_syncer_lambda_s3_object_version"></a> [syncer\_lambda\_s3\_object\_version](#input\_syncer\_lambda\_s3\_object\_version) | S3 object version for syncer lambda function. Useful if S3 versioning is enabled on source bucket. | `any` | `null` | no |
| <a name="input_tags"></a> [tags](#input\_tags) | Map of tags that will be added to created resources. By default resources will be tagged with name and environment. | `map(string)` | `{}` | no |
| <a name="input_userdata_post_install"></a> [userdata\_post\_install](#input\_userdata\_post\_install) | Script to be ran after the GitHub Actions runner is installed on the EC2 instances | `string` | `""` | no |
| <a name="input_userdata_pre_install"></a> [userdata\_pre\_install](#input\_userdata\_pre\_install) | Script to be ran before the GitHub Actions runner is installed on the EC2 instances | `string` | `""` | no |
| <a name="input_userdata_template"></a> [userdata\_template](#input\_userdata\_template) | Alternative user-data template, replacing the default template. By providing your own user\_data you have to take care of installing all required software, including the action runner. Variables userdata\_pre/post\_install are ignored. | `string` | `null` | no |
| <a name="input_volume_size"></a> [volume\_size](#input\_volume\_size) | Size of runner volume | `number` | `30` | no |
| <a name="input_vpc_id"></a> [vpc\_id](#input\_vpc\_id) | The VPC for security groups of the action runners. | `string` | n/a | yes |
| <a name="input_webhook_lambda_s3_key"></a> [webhook\_lambda\_s3\_key](#input\_webhook\_lambda\_s3\_key) | S3 key for webhook lambda function. Required if using S3 bucket to specify lambdas. | `any` | `null` | no |
| <a name="input_webhook_lambda_s3_object_version"></a> [webhook\_lambda\_s3\_object\_version](#input\_webhook\_lambda\_s3\_object\_version) | S3 object version for webhook lambda function. Useful if S3 versioning is enabled on source bucket. | `any` | `null` | no |
| <a name="input_webhook_lambda_timeout"></a> [webhook\_lambda\_timeout](#input\_webhook\_lambda\_timeout) | Time out of the webhook lambda in seconds. | `number` | `10` | no |
| <a name="input_webhook_lambda_zip"></a> [webhook\_lambda\_zip](#input\_webhook\_lambda\_zip) | File location of the webhook lambda zip file. | `string` | `null` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_binaries_syncer"></a> [binaries\_syncer](#output\_binaries\_syncer) | n/a |
| <a name="output_runners"></a> [runners](#output\_runners) | n/a |
| <a name="output_ssm_parameters"></a> [ssm\_parameters](#output\_ssm\_parameters) | n/a |
| <a name="output_webhook"></a> [webhook](#output\_webhook) | n/a |
<!-- END OF PRE-COMMIT-TERRAFORM DOCS HOOK -->

## Contribution

We welcome contribution, please checkout the [contribution guide](CONTRIBUTING.md). Be-aware we use [pre commit hooks](https://pre-commit.com/) to update the docs.

## Philips Forest

This module is part of the Philips Forest.

```bash

                                                     ___                   _
                                                    / __\__  _ __ ___  ___| |_
                                                   / _\/ _ \| '__/ _ \/ __| __|
                                                  / / | (_) | | |  __/\__ \ |_
                                                  \/   \___/|_|  \___||___/\__|

                                                                 Infrastructure

```

Talk to the forestkeepers in the `forest`-channel on Slack.

[![Slack](https://img.shields.io/badge/Slack-4A154B?style=for-the-badge&logo=slack&logoColor=white)](https://join.slack.com/t/philips-software/shared_invite/zt-xecw65v5-i1531hGP~mdVwgxLFx7ckg)
