import { describe, expect, it } from "vitest";
import { lanesTour } from "./lanesTour";

const VALID_DOCS_PREFIX = "https://www.ade-app.dev/docs/";
// Most steps target lanes.* elements; the final step anchors to the top-bar Help
// button (app.helpMenu) so the "Help lives here" copy points at the actual Help menu.
const TARGET_PATTERN = /^\[data-tour="(lanes|app)\.[a-zA-Z]+"\]$/;

describe("lanesTour", () => {
  it("registers with id 'lanes' and route '/lanes'", () => {
    expect(lanesTour.id).toBe("lanes");
    expect(lanesTour.route).toBe("/lanes");
  });

  it("has exactly 10 steps", () => {
    expect(lanesTour.steps).toHaveLength(10);
  });

  it("every step has a non-empty title and body", () => {
    for (const step of lanesTour.steps) {
      expect(step.title.trim().length, `title for target ${step.target}`).toBeGreaterThan(0);
      expect(step.body.trim().length, `body for target ${step.target}`).toBeGreaterThan(0);
    }
  });

  it("every step target matches the [data-tour=\"lanes.*\"] pattern", () => {
    for (const step of lanesTour.steps) {
      expect(step.target, `target ${step.target}`).toMatch(TARGET_PATTERN);
    }
  });

  it("every step's docUrl points at ade-app.dev/docs", () => {
    for (const step of lanesTour.steps) {
      expect(step.docUrl, `docUrl for ${step.target}`).toBeDefined();
      expect(step.docUrl!.startsWith(VALID_DOCS_PREFIX), `docUrl for ${step.target}: ${step.docUrl}`).toBe(true);
    }
  });

  it("uses only docUrls that match real Mintlify slugs verified from docs.json", () => {
    const allowed = new Set<string>([
      `${VALID_DOCS_PREFIX}welcome`,
      `${VALID_DOCS_PREFIX}key-concepts`,
      `${VALID_DOCS_PREFIX}lanes/overview`,
      `${VALID_DOCS_PREFIX}lanes/creating`,
      `${VALID_DOCS_PREFIX}lanes/stacks`,
      `${VALID_DOCS_PREFIX}lanes/packs`,
      `${VALID_DOCS_PREFIX}lanes/environment`,
      `${VALID_DOCS_PREFIX}chat/overview`,
      `${VALID_DOCS_PREFIX}chat/context`,
      `${VALID_DOCS_PREFIX}chat/capabilities`,
      `${VALID_DOCS_PREFIX}tools/terminals`,
      `${VALID_DOCS_PREFIX}tools/files-editor`,
      `${VALID_DOCS_PREFIX}guides/multi-agent-setup`,
    ]);
    for (const step of lanesTour.steps) {
      expect(allowed.has(step.docUrl!), `unknown docUrl: ${step.docUrl}`).toBe(true);
    }
  });
});
