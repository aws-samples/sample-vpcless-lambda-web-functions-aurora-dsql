import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { withStack } from './synth';

describe('cdk-nag AwsSolutions', () => {
  it('reports nothing that is not fixed or acknowledged', () => {
    withStack((app) => {
      cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
      expect(() => app.synth()).not.toThrow();
    });
  });
});
