import { beforeAll, describe, expect, it } from 'vitest';
import { type Resources, synthResources } from './synth';

let resources: Resources;
beforeAll(() => {
  resources = synthResources();
});

const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
const describeAll = (entries: [string, { Type: string }][]) => entries.map(([id, r]) => `${id} (${r.Type})`);

describe('no VPC', () => {
  it('has no AWS::EC2::* resource (VPC, subnet, security group, NAT gateway, VPC endpoint, ENI, ...)', () => {
    expect(describeAll(Object.entries(resources).filter(([, r]) => r.Type.startsWith('AWS::EC2::')))).toEqual([]);
  });

  it('gives no Web Function revision an EgressNetworkConnectorArn', () => {
    const revisions = ofType('AWS::Lambda::WebFunctionRevision');
    expect(revisions.length).toBeGreaterThan(0);
    const withConnector = revisions.filter(
      ([, r]) => (r.Properties?.ServiceConfig as Record<string, unknown> | undefined)?.EgressNetworkConnectorArn !== undefined,
    );
    expect(describeAll(withConnector)).toEqual([]);
  });

  it('gives no Lambda function a VpcConfig, including the ones CDK adds for custom resources', () => {
    const functions = ofType('AWS::Lambda::Function');
    expect(functions.length).toBeGreaterThan(0);
    expect(describeAll(functions.filter(([, r]) => r.Properties?.VpcConfig !== undefined))).toEqual([]);
  });
});

describe('/api/* cache behavior', () => {
  type Behavior = { PathPattern: string; CachePolicyId: unknown };
  let apiBehavior: Behavior | undefined;
  beforeAll(() => {
    const distribution = Object.values(resources).find((r) => r.Type === 'AWS::CloudFront::Distribution');
    const dc = distribution?.Properties?.DistributionConfig as { CacheBehaviors?: Behavior[] } | undefined;
    apiBehavior = dc?.CacheBehaviors?.find((b) => b.PathPattern === '/api/*');
  });

  // CloudFront forwards Authorization to a Web Function origin on GET/HEAD only
  // when the cache policy includes that header.
  // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html
  it('forwards Authorization in the cache key with a minimum TTL of 0', () => {
    expect(apiBehavior).toBeDefined();
    const ref = (apiBehavior?.CachePolicyId as { Ref?: string } | undefined)?.Ref;
    expect(ref).toBeDefined();
    expect(resources[ref as string]?.Properties?.CachePolicyConfig).toMatchObject({
      MinTTL: 0,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Authorization'] },
      },
    });
  });
});

describe('Cognito app client', () => {
  // Without ExplicitAuthFlows, Cognito would also allow SRP and custom auth
  // through InitiateAuth, which skip managed login.
  it('allows only ALLOW_REFRESH_TOKEN_AUTH besides the code grant', () => {
    const clients = ofType('AWS::Cognito::UserPoolClient');
    expect(clients[0]?.[1].Properties?.ExplicitAuthFlows).toEqual(['ALLOW_REFRESH_TOKEN_AUTH']);
  });
});

describe('Web Function endpoint', () => {
  // IamAuth + the resource policy: removing either opens the endpoint to everyone.
  it('has IamAuth and lets only this distribution invoke it', () => {
    expect(ofType('AWS::Lambda::WebFunctionEndpoint')[0]?.[1].Properties?.AuthType).toBe('IamAuth');
    const statement = (
      ofType('AWS::Lambda::ResourcePolicy')[0]?.[1].Properties?.PolicyDocument as { Statement: Array<Record<string, unknown>> }
    ).Statement[0];
    const distributionId = ofType('AWS::CloudFront::Distribution')[0]?.[0];
    expect(statement).toMatchObject({
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 'lambda:InvokeWebFunctionEndpoint',
    });
    const sourceArn = (statement as { Condition: { StringEquals: { 'AWS:SourceArn': unknown } } }).Condition.StringEquals[
      'AWS:SourceArn'
    ];
    expect(JSON.stringify(sourceArn)).toContain(`"Ref":"${distributionId}"`);
  });
});

describe('auto-delete-objects helper role', () => {
  // scopeAutoDeleteRoleLogs() replaces the managed AWSLambdaBasicExecutionRole
  // (logs on Resource: *) with a logs policy scoped to /aws/lambda/*. cdk-nag
  // does not inspect this generated role, so this test guards the escape hatch:
  // a future CDK rename would make it a silent no-op and this would fail.
  it('has no managed policy and does not grant logs on Resource *', () => {
    const role = ofType('AWS::IAM::Role').find(([id]) => id.includes('AutoDelete'));
    expect(role).toBeDefined();
    const props = role?.[1].Properties as {
      ManagedPolicyArns?: unknown;
      Policies?: Array<{ PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } }>;
    };
    expect(props.ManagedPolicyArns).toBeUndefined();
    const logsStatement = props.Policies?.[0]?.PolicyDocument.Statement[0];
    expect(logsStatement?.Resource).toBeDefined();
    expect(logsStatement?.Resource).not.toBe('*');
  });
});
