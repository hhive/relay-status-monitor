import { runAccountMetricRebuild } from '../src/lib/account-observability/collector';

function argument(name: '--start' | '--end'): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function utcDate(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`${name} must be an explicit UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() % 60_000 !== 0) {
    throw new Error(`${name} must align to a complete UTC minute`);
  }
  return parsed;
}

const start = utcDate(argument('--start'), '--start');
const end = utcDate(argument('--end'), '--end');
const result = await runAccountMetricRebuild(start, end);
console.log(JSON.stringify(result));
