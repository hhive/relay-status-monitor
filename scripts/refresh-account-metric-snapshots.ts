import { refreshAccountMetricSnapshots } from '../src/lib/account-observability/snapshot';

refreshAccountMetricSnapshots(new Date())
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
