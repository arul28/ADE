import { runUsageLedgerWorkerEntrypoint } from "./usageLedgerWorker";

void runUsageLedgerWorkerEntrypoint().then((exitCode) => {
  process.exitCode = exitCode;
});
