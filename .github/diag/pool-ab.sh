#!/usr/bin/env bash
# TEMP diagnostic (to be removed): pool test with and without the brain's CA read.
cd apps/desktop
run() {
  echo "=== $1"
  npx vitest run src/main/services/localRuntime/localRuntimeConnectionPool.test.ts > /tmp/pool.log 2>&1
  grep -E "Tests |localRuntimeConnectionPool.test.ts  \(" /tmp/pool.log || tail -20 /tmp/pool.log
}
off() { sed -i 's/void trustSystemCertificates(networkWarningLogger);/\/\/ diag-off/' ../ade-cli/src/cli.ts; grep -c "diag-off" ../ade-cli/src/cli.ts; }
on() { git checkout -- ../ade-cli/src/cli.ts; }
run "warmup as-is"
off; run "B1 without CA read"
on;  run "A1 as-is"
off; run "B2 without CA read"
on;  run "A2 as-is"
exit 0
