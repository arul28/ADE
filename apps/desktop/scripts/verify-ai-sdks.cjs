#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");

function checkCommandVersion(command) {
  const result = cp.spawnSync(command, ["--version"], {
    encoding: "utf8"
  });

  if (result.error) {
    return { ok: false, reason: result.error.message };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    return { ok: false, reason: stderr || `${command} --version exited with ${String(result.status)}` };
  }

  const output = (result.stdout || result.stderr || "").trim();
  return { ok: output.length > 0, reason: output.length > 0 ? output : "no version output" };
}

async function checkImport(specifier, predicate, successLabel) {
  const dynamicImport = new Function("moduleSpecifier", "return import(moduleSpecifier)");
  const moduleValue = await dynamicImport(specifier);
  if (!predicate(moduleValue)) {
    throw new Error(`${specifier} did not expose expected API`);
  }
  return successLabel;
}

async function main() {
  const failures = [];
  const passes = [];

  try {
    passes.push(await checkImport("@openai/codex-sdk", (mod) => typeof mod.Codex === "function", "codex sdk import ok"));
  } catch (error) {
    failures.push(`codex sdk import failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    passes.push(
      await checkImport(
        "ai-sdk-provider-claude-code",
        (mod) => typeof mod.claudeCode === "function",
        "claude provider sdk import ok"
      )
    );
  } catch (error) {
    failures.push(`claude provider sdk import failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const command of ["codex", "claude"]) {
    const version = checkCommandVersion(command);
    if (version.ok) {
      passes.push(`${command} cli ok (${version.reason})`);
    } else {
      failures.push(`${command} cli failed: ${version.reason}`);
    }
  }

  if (passes.length > 0) {
    process.stdout.write("AI SDK verification passed checks:\n");
    for (const pass of passes) {
      process.stdout.write(`- ${pass}\n`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write("AI SDK verification failures:\n");
    for (const failure of failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`verify-ai-sdks failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
