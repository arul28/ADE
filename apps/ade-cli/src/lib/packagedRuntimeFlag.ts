/**
 * Side-effect module: marks a process running from a built bundle as packaged,
 * before anything reads the flag. `shared/accountDirectory` trusts it to refuse
 * a development Clerk configuration. Kept out of bootstrap.ts because most `ade`
 * commands are thin clients of the brain and never load that module.
 */
import { fileURLToPath } from "node:url";
import { isSourceCheckoutRuntimeModule } from "../runtimePackaging";

const currentModulePath =
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);

if (
  !isSourceCheckoutRuntimeModule(currentModulePath)
  && process.env.ADE_RUNTIME_PACKAGED === undefined
) {
  process.env.ADE_RUNTIME_PACKAGED = "1";
}
