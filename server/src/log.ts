/**
 * Pass an object, not JSON.stringify: Lambda indexes its fields for Logs Insights. console[level], not console.log,
 * so `applicationLogLevel` filters on it. https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html
 */
export function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}): void {
  console[level]({ level, message, ...extra });
}
