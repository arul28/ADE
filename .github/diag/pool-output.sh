#!/usr/bin/env bash
# TEMP diagnostic (to be removed): full shard 4 with every spawned brain's output in the log.
cd apps/desktop
sed -i 's/stdio: \["ignore", "pipe", "pipe"\]/stdio: ["ignore", "inherit", "inherit"]/' src/main/services/localRuntime/localRuntimeConnectionPool.ts
sed -i 's/stdio: \["ignore", "ignore", "ignore"\]/stdio: ["ignore", "inherit", "inherit"]/' src/main/services/localRuntime/localRuntimeConnectionPool.test.ts
npx vitest run --shard=4/8 > /tmp/shard.log 2>&1
echo "=== brain lines"
grep -nE "ADE brain listening|ADE: |Error|error:|Cannot|ERR_|throw|Timed out|FAIL|Tests " /tmp/shard.log | grep -v "remote target gate\|unexpected IPC" | head -200
git checkout -- src/main/services/localRuntime
exit 0
