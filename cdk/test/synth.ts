import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { config } from '../../config';
import { TodoStack } from '../lib/todo-stack';

export type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

/**
 * Builds the app and stack with placeholder build output (no AWS calls, no
 * `npm run build`), runs `body` against them, then cleans up. `body` can add
 * a cdk-nag plugin before synthesizing.
 */
export function withStack<T>(body: (app: cdk.App, stack: TodoStack) => T): T {
  const workDir = mkdtempSync(join(tmpdir(), 'todo-stack-test-'));
  try {
    for (const dir of ['server', 'migrate']) {
      mkdirSync(join(workDir, dir));
      writeFileSync(join(workDir, dir, 'index.js'), '// placeholder');
    }
    const app = new cdk.App({ outdir: join(workDir, 'cdk.out') });
    const stack = new TodoStack(app, 'TodoStackTest', {
      config,
      serverCodePath: join(workDir, 'server'),
      migrateCodePath: join(workDir, 'migrate'),
      migrationsPath: join(import.meta.dirname, '..', '..', 'migrations'),
    });
    return body(app, stack);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function synthResources(): Resources {
  return withStack((_app, stack) => Template.fromStack(stack).toJSON().Resources as Resources);
}
