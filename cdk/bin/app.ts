import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { config } from '../../config';
import { TodoStack } from '../lib/todo-stack';

const root = join(import.meta.dirname, '..', '..');
const app = new cdk.App();
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

new TodoStack(app, config.stackName, {
  config,
  serverCodePath: join(root, 'dist', 'server'),
  migrateCodePath: join(root, 'dist', 'migrate'),
  migrationsPath: join(root, 'migrations'),
  description: 'A VPC-less application on AWS Lambda Web Functions and Amazon Aurora DSQL',
});
