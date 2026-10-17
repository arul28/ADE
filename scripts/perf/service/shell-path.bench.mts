// cd apps/ade-cli && npx tsx ../../scripts/perf/service/shell-path.bench.mts
// Resolving PATH for CLI lookups through a login shell that takes 0.5 s to
// start: first call, warm call, a warm call from an env whose PATH is the
// previous augmented result (callers feed it back in), the call right after
// the 60 s cache expires (served stale while a refresh runs) and the call after
// that refresh.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { augmentProcessPathWithShellAndKnownCliDirs } from "../../../apps/desktop/src/main/services/ai/cliExecutableResolver";

const home = mkdtempSync(path.join(tmpdir(), "ade-perf-shell-"));
const shell = path.join(home, "slowshell");
writeFileSync(shell, '#!/bin/sh\nsleep 0.5\nexport PATH="/fake/login/bin:$PATH"\nexec /bin/sh "$@"\n');
chmodSync(shell, 0o755);
const env = { SHELL: shell, HOME: home, PATH: "/usr/bin:/bin" };
const call = (callEnv = env) => {
  const started = performance.now();
  const resolved = augmentProcessPathWithShellAndKnownCliDirs({ env: callEnv, includeInteractiveShell: true, timeoutMs: 2000 });
  return { ms: Math.round(performance.now() - started), sawShellPath: resolved.includes("/fake/login/bin"), resolved };
};
const strip = ({ resolved: _resolved, ...rest }: ReturnType<typeof call>) => rest;
const realNow = Date.now;
const first = call();
const warm = call();
const fedBackEnv = { ...env, PATH: warm.resolved };
const fedBackWarm = call(fedBackEnv);
Date.now = () => realNow() + 61_000;
const expired = call();
setTimeout(() => {
  console.log(JSON.stringify({
    first: strip(first),
    warm: strip(warm),
    fedBackWarm: strip(fedBackWarm),
    expired: strip(expired),
    afterRefresh: strip(call()),
  }));
  process.exit(0);
}, 1500);
