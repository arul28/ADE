import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  applySmokeTokensToEnv,
  mintDeploySmokeTokens,
} from "./mint-deploy-smoke-tokens.mjs";

const tokens = await mintDeploySmokeTokens();
applySmokeTokensToEnv(tokens);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmCommand, ["run", "deploy"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
