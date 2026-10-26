#!/usr/bin/env bash
# TEMP diagnostic (to be removed): cold pool test with every spawned brain's output in the log.
cd apps/desktop
sed -i 's/stdio: \["ignore", "pipe", "pipe"\]/stdio: ["ignore", "inherit", "inherit"]/' src/main/services/localRuntime/localRuntimeConnectionPool.ts
sed -i 's/stdio: \["ignore", "ignore", "ignore"\]/stdio: ["ignore", "inherit", "inherit"]/' src/main/services/localRuntime/localRuntimeConnectionPool.test.ts
git diff --stat
npx vitest run src/main/services/localRuntime/localRuntimeConnectionPool.test.ts > /tmp/pool.log 2>&1
grep -vE "^\s*$" /tmp/pool.log | grep -iE "error|throw|exception|cannot|failed|ADE brain listening|Tests |sync disabled|ERR_|timed out" | head -150
git checkout -- src/main/services/localRuntime
exit 0
