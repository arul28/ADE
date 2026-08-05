// Pre-build CI gate. Runs in milliseconds at the top of a packaging job so a
// mis-scoped runtime download fails before the ~20 minute build rather than
// after it. Name comparison only -- the deep archive checks stay in
// validate-runtime-resources.mjs, which runs inside the build chain.

import path from "node:path";
import { fileURLToPath } from "node:url";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";

const {
  RUNTIME_TARGET_ENV,
  diffRuntimeArtifacts,
  formatRuntimeArtifactDiff,
  resolveRuntimeTargets,
} = runtimeResourceTargets;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(path.resolve(scriptDir, ".."), "resources", "runtime");

function main() {
  const runtimeTargetSet = resolveRuntimeTargets();
  if (!runtimeTargetSet.exclusive) {
    throw new Error(
      `[runtime-resources] ${RUNTIME_TARGET_ENV} must name the single target this packaging job builds. `
      + "Set it on the job so cross-platform and cross-arch runtime payloads cannot reach the bundle.",
    );
  }

  const diff = diffRuntimeArtifacts(runtimeRoot, runtimeTargetSet.targets);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    throw new Error(formatRuntimeArtifactDiff(runtimeRoot, runtimeTargetSet.targets, diff));
  }

  console.log(
    `[runtime-resources] ${runtimeRoot} holds exactly the ${runtimeTargetSet.targets.join(", ")} `
    + `runtime artifacts: ${diff.actual.join(", ")}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
