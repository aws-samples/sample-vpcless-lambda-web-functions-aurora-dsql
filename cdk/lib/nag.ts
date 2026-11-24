// IAM5 findings must be acknowledged with their `[...]` suffix, or synth still fails on them.
import * as cdk from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as cr from 'aws-cdk-lib/custom-resources';
import type { IConstruct } from 'constructs';

export interface NagTargets {
  stack: cdk.Stack;
  codeBucket: s3.Bucket;
  distribution: cloudfront.Distribution;
  userPool: cognito.UserPool;
  migrateFunction: lambda.Function;
  migrationProvider: cr.Provider;
  codeCopyRole: iam.IRole;
  providerRole: iam.IRole;
}

const HELPER = 'The grant is added by AWS CDK, not by this sample.';
const CDK_RUNTIME =
  'AWS CDK creates this function with lambda.determineLatestNodeRuntime(), nodejs24.x in aws-cdk-lib 2.278.0, and has no option to set its runtime.';

/** The code-copy singleton that WebFunctionCode.fromAssetToProvidedBucket adds at the stack root. */
function codeCopyFunction(stack: cdk.Stack): IConstruct {
  const found = stack.node.children.filter((child) => child.node.id.startsWith('Custom::S3ObjectCopy'));
  const [only] = found;
  if (!only || found.length !== 1) throw new Error(`Expected one Custom::S3ObjectCopy function, found ${found.length}.`);
  return only;
}

const ack = (scope: IConstruct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });

/** `<LogicalId.Arn>` as cdk-nag prints it in IAM5 finding IDs. */
const arnToken = (stack: cdk.Stack, resource: IConstruct) =>
  `<${stack.getLogicalId(resource.node.defaultChild as cdk.CfnElement)}.Arn>`;

export function acknowledgeNagFindings(t: NagTargets): void {
  ack(t.distribution, 'AwsSolutions-CFR1', 'No geo restriction; not needed for this sample.');
  ack(
    t.distribution,
    'AwsSolutions-CFR2',
    "No AWS WAF web ACL, to keep the sample small. The endpoint's rateLimit is the only limit, and it is shared by all callers; add a web ACL with a per-IP rate-based rule for production.",
  );
  ack(
    t.distribution,
    'AwsSolutions-CFR3',
    'No CloudFront access logs, so the sample needs no log bucket. Turn them on for production.',
  );
  ack(
    t.distribution,
    'AwsSolutions-CFR4',
    'The default *.cloudfront.net certificate does not let you choose the minimum viewer TLS version; that needs a custom domain and an ACM certificate.',
  );
  ack(
    t.codeBucket,
    'AwsSolutions-S1',
    "No server access logs on the bucket that holds the Web Function's code zip. The bucket blocks public access and enforces TLS, and only the deployment writes to it.",
  );
  ack(
    t.userPool,
    'AwsSolutions-COG2',
    'MFA is off so the sample can be tried with a password alone. Self sign-up is off, so only users an administrator creates can sign in. Turn MFA on for production.',
  );
  ack(
    t.userPool,
    'AwsSolutions-COG8',
    'No threat protection, which needs the Cognito Plus feature plan at extra cost. Turn it on for production if you need it.',
  );

  // aws-cdk-lib 2.278.0 added Runtime.NODEJS_26_X, so cdk-nag AwsSolutions-L1 flags these nodejs24.x functions.
  ack(
    t.migrateFunction,
    'AwsSolutions-L1',
    'nodejs24.x to match the Web Function: WebFunctionRuntime in aws-cdk-lib 2.278.0 defines only NODEJS_24_X. Move both to Node.js 26 together.',
  );
  ack(t.migrationProvider.node.findChild('framework-onEvent'), 'AwsSolutions-L1', CDK_RUNTIME);
  ack(codeCopyFunction(t.stack), 'AwsSolutions-L1', CDK_RUNTIME);

  // S3 grants that fromAssetToProvidedBucket adds to copyOptions.role; its API cannot narrow them.
  for (const finding of [
    'Action::s3:Abort*',
    'Action::s3:DeleteObject*',
    'Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-<AWS::AccountId>-<AWS::Region>/*',
    `Resource::${arnToken(t.stack, t.codeBucket)}/web-function/*`,
  ]) {
    ack(
      t.codeCopyRole,
      `AwsSolutions-IAM5[${finding}]`,
      `The copy helper reads the code zip from the CDK assets bucket and writes/deletes only under this code bucket's web-function/* prefix. ${HELPER}`,
    );
  }

  // The invoke grant that custom_resources.Provider adds to frameworkOnEventRole; its API cannot narrow it.
  ack(
    t.providerRole,
    `AwsSolutions-IAM5[Resource::${arnToken(t.stack, t.migrateFunction)}:*]`,
    `The provider framework may invoke any version of the migration function; the construct grants this to the role. ${HELPER}`,
  );
}
