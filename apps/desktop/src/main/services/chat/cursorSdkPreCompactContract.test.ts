import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_PRECOMPACT_HOOK_FIELDS, CURSOR_PRECOMPACT_HOOK_STEP } from "./cursorSdkTelemetry";

/**
 * ADE's Cursor compaction signal rides an UNDOCUMENTED hook: `preCompact`, whose
 * stdin JSON the SDK builds from agent-core's `PreCompactRequestQuery`. Nothing
 * public promises it survives an SDK bump, so this reads the installed SDK's
 * shipped JavaScript and fails, by name, on the first piece that moved.
 */

const SDK_CHANGED = "The Cursor SDK changed its undocumented PreCompact hook";

function cursorSdkRoot(): string {
  const entry = createRequire(import.meta.url).resolve("@cursor/sdk");
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; version?: string };
    if (parsed.name === "@cursor/sdk") return dir;
  }
  throw new Error(`Could not find the @cursor/sdk package root above ${entry}.`);
}

function readDistFlavor(root: string, flavor: "cjs" | "esm"): Array<{ file: string; source: string }> {
  const dir = path.join(root, "dist", flavor);
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ file: `dist/${flavor}/${name}`, source: fs.readFileSync(path.join(dir, name), "utf8") }));
}

const HANDLER_MARKER = `case"${CURSOR_PRECOMPACT_HOOK_STEP}":{`;

describe("Cursor SDK preCompact hook contract", () => {
  const root = cursorSdkRoot();
  const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version;

  for (const flavor of ["cjs", "esm"] as const) {
    it(`still builds every preCompact field ADE reads (${flavor})`, () => {
      const files = readDistFlavor(root, flavor);
      const stepMap = files.find(({ source }) =>
        source.includes(`${CURSOR_PRECOMPACT_HOOK_STEP}:"${CURSOR_PRECOMPACT_HOOK_STEP}"`));
      if (!stepMap) {
        throw new Error(
          `${SDK_CHANGED}: @cursor/sdk ${version} (dist/${flavor}) no longer registers a "${CURSOR_PRECOMPACT_HOOK_STEP}" hook step, `
          + "so the hooks.json entry ADE writes never runs. Find the new step name and update cursorSdkTelemetry.ts and cursorSdkHooks.ts.",
        );
      }

      const handlerFile = files.find(({ source }) => source.includes(HANDLER_MARKER));
      if (!handlerFile) {
        throw new Error(
          `${SDK_CHANGED}: @cursor/sdk ${version} (dist/${flavor}) no longer handles a "${CURSOR_PRECOMPACT_HOOK_STEP}" hook request, `
          + "so no compaction payload reaches ADE. Compaction falls back to status-text matching.",
        );
      }
      const start = handlerFile.source.indexOf(HANDLER_MARKER);
      const dispatch = handlerFile.source.indexOf(`executeHookForStep(`, start);
      const handler = handlerFile.source.slice(start, dispatch < 0 ? start + 2_000 : dispatch + 80);
      expect(handler).toContain(`.${CURSOR_PRECOMPACT_HOOK_STEP}`);

      const missing = CURSOR_PRECOMPACT_HOOK_FIELDS.filter((field) => !handler.includes(`${field}:`));
      if (missing.length) {
        throw new Error(
          `${SDK_CHANGED}: @cursor/sdk ${version} (${handlerFile.file}) no longer sends ${missing.map((field) => `"${field}"`).join(", ")} `
          + "in the preCompact hook payload. ADE reads these in parseCursorPreCompactHookPayload (cursorSdkTelemetry.ts): "
          + "rename or drop them there and in CURSOR_PRECOMPACT_HOOK_FIELDS.",
        );
      }
      expect(missing).toEqual([]);
    });
  }

  it("still ships the PreCompactRequestQuery proto the hook payload comes from", () => {
    const index = fs.readFileSync(path.join(root, "dist", "cjs", "index.js"), "utf8");
    if (!index.includes("PreCompactRequestQuery")) {
      throw new Error(
        `${SDK_CHANGED}: @cursor/sdk ${version} no longer ships agent.v1.PreCompactRequestQuery. `
        + "Re-check the preCompact hook payload fields before trusting cursorSdkTelemetry.ts.",
      );
    }
  });
});
