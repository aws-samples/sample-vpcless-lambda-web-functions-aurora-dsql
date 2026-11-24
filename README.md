# A VPC-less application on AWS Lambda Web Functions and Amazon Aurora DSQL

[日本語](README.ja.md)

## Overview

An application that runs on AWS Lambda Web Functions and Amazon Aurora DSQL. **It creates no VPC, subnets, security groups, or NAT gateway.** The data lives in tables linked by foreign keys and is read with `JOIN`s in PostgreSQL-compatible SQL. The subject is a set of shared TODO lists. Everyone who signs in shares all the lists and TODOs.

> [!IMPORTANT]
> This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory, and compliance requirements before deployment.

## Architecture

![Architecture: a browser reaches Amazon CloudFront, which signs requests with origin access control to an AWS Lambda Web Function endpoint (IamAuth). The Web Function connects to Amazon Aurora DSQL's public endpoint with IAM authentication and verifies Amazon Cognito access tokens. No VPC resources exist.](docs/architecture.png)

How a request flows:

1. The browser only talks to CloudFront.
2. CloudFront calls the Web Function with signed requests, and the Web Function accepts no unsigned request ([`cdk/lib/todo-stack.ts`](cdk/lib/todo-stack.ts)).
3. The Web Function checks the Cognito access token before it handles a protected API request ([`server/src/middleware.ts`](server/src/middleware.ts)).
4. The Web Function connects to Aurora DSQL with IAM authentication, not a password ([`server/src/db.ts`](server/src/db.ts)).

There are three tables: `users`, `lists`, and `todos` ([`migrations/`](migrations/), [`server/src/repository.ts`](server/src/repository.ts)).

## Prerequisites

- Node.js 24 or later, npm, and AWS CLI v2 with credentials
- A Region with both [Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html) and [Aurora DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/what-is-aurora-dsql.html) ([Services by Region](https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/))
- The account and Region you deploy to come from your AWS CLI configuration. With a named profile, run `export AWS_PROFILE=<name>` first

## Deployment

Settings you change live in [`config.ts`](config.ts). You can deploy with the defaults. The stack name, `stackName`, defaults to `SharedTodo`.

1. Install the dependencies and build.

   ```sh
   npm ci
   npm run build
   ```

2. If this is the first time you use the CDK in the account and Region, [bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) once (check whether it is done with `aws cloudformation describe-stacks --stack-name CDKToolkit`).

   ```sh
   npx cdk bootstrap
   ```

3. Deploy.

   ```sh
   npm run deploy
   ```

`npm run deploy` asks you to confirm the IAM changes; answer `y`. It takes 5 to 10 minutes. The stack outputs `AppUrl`, `UserPoolId`, `NextStep`, and `EndpointUrl`.

### Create users

Self sign-up is disabled, so create a user with the command in the `NextStep` output. Replace `you@example.com` with your own e-mail address and run it; Cognito e-mails you a temporary password.

See [Usage](#usage) for how to sign in.

<details>
<summary>Try it without e-mail</summary>

Add `--message-action SUPPRESS` to the `NextStep` command, run it, and set a password with the script below (bash and zsh). In the script, replace `<UserPoolId>` with the `UserPoolId` output. Keep `Username` the same as `--username` in the `NextStep` command (`alice`).

```sh
F=$(mktemp); trap 'rm -f "$F"' EXIT HUP INT TERM   # outside the repo, removed on exit
printf 'New password: '; IFS= read -rs PASSWORD; echo
printf '%s' "$PASSWORD" | node -e 'process.stdout.write(JSON.stringify({UserPoolId: process.argv[1], Username: "alice", Password: require("fs").readFileSync(0, "utf8"), Permanent: true}))' "<UserPoolId>" > "$F"; unset PASSWORD
aws cognito-idp admin-set-user-password --cli-input-json "file://$F"; rm -f "$F"
```

</details>

## Usage

Open `AppUrl`, sign in as the user you created, and create a list and a TODO. If you sign in with the temporary password, you are asked to choose a new one. The app follows the browser's language (English or Japanese).

### Logs and metrics

- Logs: `/aws/lambda/web/<stackName>`. Each retry after an Aurora DSQL conflict logs one line (`conflict`, `attempt`). Requests are not logged one by one ([Web Function logs](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html)).
- Metrics: CloudWatch namespace `AWS/AuroraDSQL` (`OccConflicts`, `TotalDPU`) ([metrics](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/cloudwatch-monitoring.html)). [Database Insights](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/dsql-db-insights.html) shows the load per SQL statement with no setup.

## Cost

While the app is not in use, you pay for storage for the database, the code bucket, and logs. CloudFront and Cognito (the default Essentials plan) have monthly free tiers. Estimate the cost for your usage with the [Lambda](https://aws.amazon.com/lambda/pricing/), [Aurora DSQL](https://aws.amazon.com/rds/aurora/dsql/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), and [Cognito](https://aws.amazon.com/cognito/pricing/) pricing pages and the [AWS Pricing Calculator](https://calculator.aws/).

## Clean up

Destroy the stack when you are done. Anyone who knows the URL can send requests while it is deployed.

```sh
npm run destroy
```

Answer `y` when asked. It takes about 5 to 10 minutes. This deletes the lists, the TODOs, and the user pool with every user. If you turned on the cluster's deletion protection in `config.ts`, turn it off and deploy first.

After `destroy`, one log group is left behind; find and delete it with these commands:

```sh
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/<stackName>-CustomS3AutoDeleteObjects --query 'logGroups[].logGroupName' --output text
aws logs delete-log-group --log-group-name <name from the list>
```

## Considerations for production

**Authentication**

- Use refresh token rotation and review token lifetimes ([refresh token rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html#using-the-refresh-token-rotation), [token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html))
- Turn on Cognito [MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html), [threat protection](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html) (the Plus feature plan), and [deletion protection](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-deletion-protection.html)

**Entry points and access paths**

- Add [AWS WAF](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-awswaf.html) with a per-IP rate-based rule (the endpoint's `rateLimit` is one limit for all callers)
- Use a [custom domain](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html) to set the minimum TLS version
- Narrow who in the account can reach the endpoint or Aurora DSQL directly. `lambda:InvokeWebFunctionEndpoint` lets a caller skip CloudFront, so limit who has it in IAM policies; broad policies such as `lambda:*` or AdministratorAccess also grant it ([endpoint access control](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html)). Limit `dsql:DbConnect` and `dsql:DbConnectAdmin` to the Web Function and migration roles, through IAM and a cluster [resource-based policy](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/resource-based-policies.html)

**Data protection**

- Turn on deletion protection for the Aurora DSQL cluster and take [backups](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/backup-aurora-dsql.html)

**Capacity**

- Size `maxEnvironments`, `rateLimit`, and `pool.max` for your traffic, and keep `maxEnvironments` × `pool.max` within Aurora DSQL's [connection quotas](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html) (see `config.ts`)

**Monitoring and logs**

- Turn on [CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/AccessLogs.html) and [S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerLogs.html) access logs (not enabled in this sample)
- Set up [alarms](https://docs.aws.amazon.com/lambda/latest/dg/lambda-monitoring.html) and choose a log retention period. Also watch [`EndpointActiveEnvironments` and `EndpointActiveEnvironmentThrottles`](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html)

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
