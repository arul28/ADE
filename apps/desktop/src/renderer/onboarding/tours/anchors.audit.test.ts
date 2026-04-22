/* @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import "./index"; // side-effect: register every tour
import { listTours } from "../registry";

/**
 * Ground truth: every `data-tour="..."` anchor currently present in the app.
 *
 * This set is derived by grepping the renderer components tree for three
 * shapes that all end up rendering as a `data-tour` attribute on an element:
 *
 *   1. Literal attribute:   `data-tour="foo.bar"`
 *   2. `dataTour` prop passed to `FloatingPane` / `LaneWorkPane`, which
 *      forwards it as `data-tour={dataTour}`.
 *   3. Object-spread:       `{...(cond ? { "data-tour": "foo.bar" } : {})}`
 *   4. Dynamic template:    `data-tour={`settings.${s.id}`}` — only one
 *      occurrence today, in SettingsPage's section nav.
 *
 * Keep this list in sync when a tour starts using a new anchor or a
 * component removes one. The test below fails if a tour step points at
 * something that isn't here.
 */
const KNOWN_ANCHORS = new Set<string>([
  // app chrome
  "app.helpMenu",
  "app.openProject",
  // automations
  "automations.actionsList",
  "automations.createTrigger",
  "automations.guardrails",
  "automations.triggersList",
  // CTO
  "cto.linearPanel",
  "cto.settingsPanel",
  "cto.sidebar",
  "cto.teamPanel",
  // files
  "files.breadcrumb",
  "files.editorPane",
  "files.explorerPane",
  "files.fileTree",
  "files.header",
  "files.modeToggle",
  "files.openIn",
  "files.searchBar",
  "files.terminalsPane",
  "files.workspaceSelector",
  // graph
  "graph.canvas",
  "graph.legend",
  "graph.node",
  "graph.pan",
  "graph.zoom",
  // history
  "history.entries",
  "history.entry",
  "history.column-settings",
  "history.filter",
  // lanes (literal)
  "lanes.addWorktrees",
  "lanes.branchSelector",
  "lanes.createDialog.attachTab",
  "lanes.createDialog.branchBase",
  "lanes.createDialog.create",
  "lanes.createDialog.name",
  "lanes.createDialog.tabs",
  "lanes.filter",
  "lanes.laneTab",
  "lanes.manageDialog.adopt",
  "lanes.manageDialog.archive",
  "lanes.manageDialog.delete",
  "lanes.manageDialog.rename",
  "lanes.manageDialog.tabs",
  "lanes.moveToAde",
  "lanes.newLane",
  "lanes.resetGrid",
  "lanes.statusChips",
  // lanes (dataTour-prop bindings on FloatingPane / LaneWorkPane)
  "lanes.diffPane",
  "lanes.gitActionsPane",
  "lanes.stackPane",
  "lanes.workCliTool",
  "lanes.workNewChat",
  "lanes.workNewShell",
  "lanes.workPane",
  // prs
  "prs.checksPanel",
  "prs.closeBtn",
  "prs.conflictSim",
  "prs.createBtn",
  "prs.createModal.base",
  "prs.createModal.body",
  "prs.createModal.submit",
  "prs.createModal.title",
  "prs.detailDrawer",
  "prs.list",
  "prs.listRow",
  "prs.stackingIndicator",
  // run
  "run.addCommand",
  "run.commandCards",
  "run.groupFilter",
  "run.header",
  "run.laneSelector",
  "run.newShell",
  "run.processMonitor",
  "run.runButton",
  "run.runtimeBar",
  "run.stackTabs",
  "run.stopButton",
  // settings (emitted by the dynamic SettingsPage nav template literal)
  "settings.ai",
  "settings.appearance",
  "settings.general",
  "settings.integrations",
  "settings.laneTemplates",
  "settings.memory",
  "settings.mobilePush",
  "settings.onboarding",
  "settings.sync",
  "settings.usage",
  "settings.workspace",
  // work (top-level Work tab + lane work pane)
  "work.crossLaneSwitch",
  "work.entryOptions",
  "work.focusToolbar",
  "work.laneFilter",
  "work.laneName",
  "work.newSession",
  "work.sessionCount",
  "work.sessionItem",
  "work.sessionsHeader",
  "work.sessionsPane",
  "work.toolbar",
  "work.viewArea",
]);

function extractAnchor(target: string): string | null {
  const match = target.match(/^\[data-tour="([^"]+)"\]$/);
  return match ? match[1] : null;
}

describe("tour anchor audit", () => {
  it("every tour step target points at a known anchor (or is empty for hero steps)", () => {
    const missing: string[] = [];
    const malformed: string[] = [];
    for (const tour of listTours()) {
      for (const step of tour.steps) {
        const id = step.id ?? "?";
        const label = `${tour.id}(${tour.variant ?? "full"})::${id}`;
        if (!step.target) continue;
        const anchor = extractAnchor(step.target);
        if (anchor == null) {
          malformed.push(`${label} → ${step.target}`);
          continue;
        }
        if (!KNOWN_ANCHORS.has(anchor)) {
          missing.push(`${label} → ${anchor}`);
        }
      }
    }
    expect(
      malformed,
      "tour steps with malformed target (must be '' or '[data-tour=\"name\"]'):\n" +
        malformed.join("\n"),
    ).toEqual([]);
    expect(
      missing,
      "tour steps referencing missing anchors:\n" + missing.join("\n"),
    ).toEqual([]);
  });

  it("every ghost-cursor from/to selector points at a known anchor", () => {
    const missing: string[] = [];
    for (const tour of listTours()) {
      for (const step of tour.steps) {
        if (!step.ghostCursor) continue;
        for (const end of ["from", "to"] as const) {
          const sel = step.ghostCursor[end];
          if (!sel) continue;
          const anchor = extractAnchor(sel);
          if (anchor == null) continue; // non-[data-tour] selectors allowed
          if (!KNOWN_ANCHORS.has(anchor)) {
            missing.push(
              `${tour.id}(${tour.variant ?? "full"})::${step.id ?? "?"} ghost.${end} → ${anchor}`,
            );
          }
        }
      }
    }
    expect(
      missing,
      "ghost-cursor endpoints referencing missing anchors:\n" + missing.join("\n"),
    ).toEqual([]);
  });

  it("every waitForSelector (when set) points at a known anchor", () => {
    const missing: string[] = [];
    for (const tour of listTours()) {
      for (const step of tour.steps) {
        if (!step.waitForSelector) continue;
        const anchor = extractAnchor(step.waitForSelector);
        if (anchor == null) continue;
        if (!KNOWN_ANCHORS.has(anchor)) {
          missing.push(
            `${tour.id}(${tour.variant ?? "full"})::${step.id ?? "?"} waitForSelector → ${anchor}`,
          );
        }
      }
    }
    expect(
      missing,
      "waitForSelector entries referencing missing anchors:\n" + missing.join("\n"),
    ).toEqual([]);
  });
});
