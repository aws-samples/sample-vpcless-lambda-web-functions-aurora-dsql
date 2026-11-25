import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { Config } from '../../config';
import { acknowledgeNagFindings } from './nag';

export interface TodoStackProps extends cdk.StackProps {
  config: Config;
  serverCodePath: string;
  migrateCodePath: string;
  migrationsPath: string;
}

export class TodoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TodoStackProps) {
    super(scope, id, props);
    const { config } = props;
    const functionName = config.stackName;
    const endpointName = config.webFunction.endpointName;
    const authConfigParameterName = `/${config.stackName}/auth-config`;
    const retention = toRetentionDays(config.logRetentionDays);

    // Roles scoped to one log group: the CDK default, AWSLambdaBasicExecutionRole, allows logs on Resource: *.
    const helperLogGroup = (id: string) =>
      new logs.LogGroup(this, id, { retention, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const helperRole = (id: string, logGroup: logs.LogGroup) =>
      new iam.Role(this, id, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          Logs: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }),
            ],
          }),
        },
      });

    const cluster = new dsql.CfnCluster(this, 'Cluster', {
      deletionProtectionEnabled: config.database.deletionProtection,
      tags: [{ key: 'Name', value: config.stackName }],
    });

    // Must stay versioned: a Web Function revision loads its zip from a versioned S3 object.
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    scopeAutoDeleteRoleLogs(this);
    const codeCopyLogs = helperLogGroup('CodeCopyLogs');
    const codeCopyRole = helperRole('CodeCopyRole', codeCopyLogs);

    // Lambda writes Web Function logs to `<group>.local` first, then into `<group>`: without write access to both, no
    // log arrives. A MultiRegion/PerRegion endpoint needs a `.local` group per Region.
    // https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html
    const webLogGroup = new logs.LogGroup(this, 'WebFunctionLogs', {
      logGroupName: `/aws/lambda/web/${functionName}`,
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const webLocalLogGroup = new logs.LogGroup(this, 'WebFunctionLocalLogs', {
      logGroupName: `/aws/lambda/web/${functionName}.local`,
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionRole = new iam.Role(this, 'WebFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Runs the ${functionName} Web Function: logs, dsql:DbConnect, one SSM parameter`,
    });
    webLogGroup.grantWrite(executionRole);
    webLocalLogGroup.grantWrite(executionRole);
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dsql:DbConnect'],
        resources: [cluster.attrResourceArn],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: authConfigParameterName.slice(1) }),
        ],
      }),
    );

    const migrateLogGroup = helperLogGroup('MigrateLogs');
    const migrateRole = new iam.Role(this, 'MigrateFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Runs the ${functionName} migration: its log group, dsql:DbConnectAdmin`,
      inlinePolicies: {
        MigrationPermissions: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [migrateLogGroup.logGroupArn],
            }),
            new iam.PolicyStatement({ actions: ['dsql:DbConnectAdmin'], resources: [cluster.attrResourceArn] }),
          ],
        }),
      },
    });
    const migrateFunction = new lambda.Function(this, 'MigrateFunction', {
      description: 'Applies migrations/*.sql to Aurora DSQL during cdk deploy (admin role)',
      runtime: lambda.Runtime.NODEJS_26_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(props.migrateCodePath),
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      logGroup: migrateLogGroup,
      role: migrateRole,
      environment: {
        DSQL_ENDPOINT: cluster.attrEndpoint,
        APP_ROLE_IAM_ARN: executionRole.roleArn,
      },
    });
    const providerLogs = helperLogGroup('MigrationProviderLogs');
    const providerRole = helperRole('MigrationProviderRole', providerLogs);
    const migrationProvider = new cr.Provider(this, 'MigrationProvider', {
      onEventHandler: migrateFunction,
      logGroup: providerLogs,
      frameworkOnEventRole: providerRole,
    });
    const migration = new cdk.CustomResource(this, 'Migration', {
      serviceToken: migrationProvider.serviceToken,
      resourceType: 'Custom::DsqlMigration',
      properties: {
        // The handler ignores Endpoint and AppRoleArn (see readSettings()); they are here so that replacing the cluster
        // or the app role re-runs the migration.
        MigrationsHash: hashSqlFiles(props.migrationsPath),
        Endpoint: cluster.attrEndpoint,
        AppRoleArn: executionRole.roleArn,
      },
    });

    const webFunction = new lambda.WebFunction(this, 'WebFunction', {
      webFunctionName: functionName,
      revisionDescription: 'Deployed by npm run deploy',
      runtime: lambda.WebFunctionRuntime.of('nodejs26.x'),
      code: lambda.WebFunctionCode.fromAssetToProvidedBucket(codeBucket, props.serverCodePath, {
        copyOptions: { logGroup: codeCopyLogs, role: codeCopyRole },
      }),
      role: executionRole,
      logGroup: webLogGroup,
      timeout: cdk.Duration.seconds(config.webFunction.timeoutSeconds),
      maxConcurrencyPerEnvironment: config.webFunction.maxConcurrencyPerEnvironment,
      environment: {
        DSQL_ENDPOINT: cluster.attrEndpoint,
        // Only the parameter name: the Cognito client ID here would make a dependency cycle (its callback URL is the
        // CloudFront URL, CloudFront points at the endpoint, the endpoint at this revision).
        AUTH_CONFIG_PARAMETER: authConfigParameterName,
      },
      defaultEndpointAuth: lambda.WebFunctionAuthType.IAM_AUTH,
      defaultEndpoint: {
        endpointName,
        maxEnvironments: config.webFunction.maxEnvironments,
        rateLimit: config.webFunction.rateLimit,
      },
    });
    const endpoint = webFunction.endpoint;
    // The `.local` log group and the schema must exist before the revision serves traffic.
    webFunction.resourceRevision.node.addDependency(webLocalLogGroup, migration);

    // Web Function origins require type `lambda` and `always-amz-auth`; CloudFront then signs in its own header and
    // passes the viewer's Authorization header (the Cognito access token) through.
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        // OAC names are unique per account across Regions; without the Region a second Region's deploy gets 409.
        name: `${config.stackName}-${cdk.Aws.REGION}-web-function`,
        description: `Signs CloudFront requests to the ${functionName} Web Function`,
        originAccessControlOriginType: 'lambda',
        signingProtocol: 'sigv4',
        signingBehavior: 'always-amz-auth',
      },
    });
    const origin = new origins.HttpOrigin(endpoint.domainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      originAccessControlId: oac.attrId,
    });
    // Host must be the endpoint's domain, or the endpoint answers 404.
    const originRequestPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    // Authorization is in the cache key so CloudFront forwards it on GET/HEAD. Max TTL is 1 s, not 0: all-zero TTLs
    // disable caching, and the docs do not say the header is still forwarded then (responses are no-store anyway).
    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      comment: 'Forwards Authorization to the Web Function; responses are no-store',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const base = { origin, originRequestPolicy };
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: config.stackName,
      defaultBehavior: {
        ...base,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        '/assets/*': {
          ...base,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        '/api/*': {
          ...base,
          // No redirect: a redirected POST/PATCH loses its body, and the token was already sent over HTTP.
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
        },
      },
    });

    // Written out instead of grants.invoke(), which would let any CloudFront distribution invoke the endpoint;
    // aws:SourceArn limits it to this one.
    endpoint.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowThisCloudFrontDistribution',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['lambda:InvokeWebFunctionEndpoint'],
        resources: [endpoint.endpointArn],
        conditions: { StringEquals: { 'AWS:SourceArn': distribution.distributionArn } },
      }),
    );

    const appUrl = `https://${distribution.distributionDomainName}/`;

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // The CDK defaults, written out because cdk-nag AwsSolutions-COG1 fails synth without them.
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const domain = userPool.addDomain('Domain', {
      // Not a fixed prefix, which can clash: the UUID at the end of the stack ID is unique per stack without a lookup.
      cognitoDomain: { domainPrefix: cdk.Fn.join('-', ['todo', cdk.Fn.select(2, cdk.Fn.split('/', this.stackId))]) },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const client = userPool.addClient('SpaClient', {
      generateSecret: false,
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      enableTokenRevocation: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [appUrl],
        logoutUrls: [appUrl],
      },
    });
    // Set on L1: CDK omits the property for `authFlows: {}`, and Cognito then also enables SRP and custom auth, letting
    // anyone with the public client ID skip managed login. Refresh stays for oidc-client-ts.
    // https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html
    (client.node.defaultChild as cognito.CfnUserPoolClient).explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH'];
    // Without a branding style, managed login (NEWER_MANAGED_LOGIN) renders no page for a programmatically created client.
    // https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateManagedLoginBranding.html
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new ssm.StringParameter(this, 'AuthConfig', {
      parameterName: authConfigParameterName,
      description: 'Cognito settings read by the Web Function (public values, not secrets)',
      stringValue: this.toJsonString({
        userPoolId: userPool.userPoolId,
        clientId: client.userPoolClientId,
        domain: domain.baseUrl(),
      }),
    });

    new cdk.CfnOutput(this, 'AppUrl', { description: 'Open this in a browser', value: appUrl });
    new cdk.CfnOutput(this, 'UserPoolId', { description: 'Use with aws cognito-idp admin-create-user', value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'EndpointUrl', {
      description: 'The Web Function endpoint. Unsigned requests to it get 403.',
      value: `https://${endpoint.domainName}/`,
    });
    new cdk.CfnOutput(this, 'NextStep', {
      description: 'Run this to create your first user, with your own e-mail address instead of you@example.com',
      value: `aws cognito-idp admin-create-user --user-pool-id ${userPool.userPoolId} --region ${cdk.Aws.REGION} --username alice --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true`,
    });

    acknowledgeNagFindings({
      stack: this,
      codeBucket,
      distribution,
      userPool,
      migrateFunction,
      migrationProvider,
      codeCopyRole,
      providerRole,
    });
  }
}

function hashSqlFiles(directory: string): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.sql')).sort()) {
    hash.update(name).update('\0').update(readFileSync(join(directory, name))).update('\0');
  }
  return hash.digest('hex');
}

function toRetentionDays(days: number): logs.RetentionDays {
  const match = Object.entries(logs.RetentionDays).find(([, value]) => value === days);
  if (!match) {
    const allowed = Object.values(logs.RetentionDays).filter((v) => typeof v === 'number').join(', ');
    throw new Error(`config.logRetentionDays ${days} is not a CloudWatch Logs retention value. Use one of: ${allowed}.`);
  }
  return days as logs.RetentionDays;
}

/**
 * Escape hatch (CDK has no API for this role): narrows the autoDeleteObjects helper's role from AWSLambdaBasicExecutionRole
 * (logs on *) to Lambda log groups. If a CDK version renames these nodes it silently does nothing, and cdk-nag does not
 * check this role. Naming the helper's own log group instead would be a circular dependency.
 */
function scopeAutoDeleteRoleLogs(stack: cdk.Stack): void {
  const provider = stack.node.tryFindChild('Custom::S3AutoDeleteObjectsCustomResourceProvider');
  const role = provider?.node.tryFindChild('Role') as cdk.CfnResource | undefined;
  if (!role) return;
  role.addPropertyOverride('ManagedPolicyArns', undefined);
  role.addPropertyOverride('Policies', [
    {
      PolicyName: 'Logs',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: cdk.Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*'),
          },
        ],
      },
    },
  ]);
}
