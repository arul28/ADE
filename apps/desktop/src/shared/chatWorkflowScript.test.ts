import { describe, expect, it } from "vitest";
import { readWorkflowMetaName, readWorkflowMetaPhases, readWorkflowScriptPlan } from "./chatWorkflowScript";

/**
 * The workflow script is provider-authored text, and the two things read out of
 * it — the run's name and its phases — are drawn in the transcript and the
 * actions pane. So the reader must answer only from the script's declared
 * `meta` block: an agent's own `name:` above it, or a nested object's `phases`,
 * would otherwise be reported as the run's.
 */
describe("chatWorkflowScript", () => {
  const script = [
    "// helpers the workflow body uses",
    "const meta = { name: 'skate-build', description: 'streams', phases: [",
    "  { title: 'Plan', detail: 'one agent' },",
    "  { title: 'Build', detail: 'five agents' },",
    "  { title: 'Verify', detail: 'one agent' },",
    "] }",
    "const helpers = { name: 'not-the-run-name', phases: ['nope'] }",
    "export default async function run() {}",
  ].join("\n");

  it("reads the name and the phases the meta block declares", () => {
    expect(readWorkflowMetaName(script)).toBe("skate-build");
    expect(readWorkflowMetaPhases(script)).toEqual(["Plan", "Build", "Verify"]);
    expect(readWorkflowScriptPlan(script)).toEqual({
      name: "skate-build",
      phases: ["Plan", "Build", "Verify"],
      lines: 8,
    });
  });

  it("never reports a helper's name or a nested phases list as the run's", () => {
    // A `name:` before meta, and a `phases:` in a later object: both used to be
    // picked up because the patterns searched the whole script.
    const noisy = [
      "const config = { name: 'helper-name' }",
      "const meta = { phases: [{ title: 'OnlyPhase' }] }",
      "const after = { name: 'later-name', phases: ['nope'] }",
    ].join("\n");
    expect(readWorkflowMetaName(noisy)).toBeNull();
    expect(readWorkflowMetaPhases(noisy)).toEqual(["OnlyPhase"]);
  });

  it("answers null/empty for a script with no meta block, and for nothing at all", () => {
    expect(readWorkflowScriptPlan("console.log('no meta here')")).toEqual({
      name: null,
      phases: [],
      lines: 1,
    });
    expect(readWorkflowScriptPlan("")).toBeNull();
    expect(readWorkflowScriptPlan(null)).toBeNull();
    expect(readWorkflowScriptPlan(undefined)).toBeNull();
  });
});
