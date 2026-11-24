export const config = {
  /** CloudFormation stack name, also used as the Web Function name. */
  stackName: 'SharedTodo',

  /** Log retention in days; a logs.RetentionDays value (1, 3, 5, 7, 14, 30, ...). */
  logRetentionDays: 7,

  webFunction: {
    endpointName: 'live',
    /** Request timeout of the Web Function, in seconds (3-900). */
    timeoutSeconds: 30,
    /** Upper bound of concurrent requests per execution environment (1-128). */
    maxConcurrencyPerEnvironment: 64,
    /** Upper bound of execution environments (2-10,000); caps cost: https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html */
    maxEnvironments: 10,
    /** Requests per second before 429 (100-1,000 in steps of 100, then 2,000-10,000 in steps of 1,000). */
    rateLimit: 100,
  },

  database: {
    /** Deletion protection of the Aurora DSQL cluster; turn it on before you store data you want to keep. */
    deletionProtection: false,
    /** Per execution environment; keep maxEnvironments x max within https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html */
    pool: {
      max: 10,
      /** Wait for a free or new connection before 503, in milliseconds. */
      connectionTimeoutMillis: 5_000,
    },
  },
} as const;

export type Config = typeof config;
