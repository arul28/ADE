import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("dist:win:test must run on Windows.");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
console.log(
  "[windows-test-build] Building an unsigned local installer without macOS/Linux remote runtime sidecars.",
);

const child = spawn("npm.cmd", ["run", "dist:win"], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
    ADE_WINDOWS_TEST_BUILD: "1",
  },
  stdio: "inherit",
  windowsHide: true,
  shell: true,
});

child.once("error", (error) => {
  console.error(`[windows-test-build] Unable to start the build: ${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
