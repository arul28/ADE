/**
 * Every launch an agent, a script or an outside app starts names its model.
 * ADE never picks one for them: a default chosen behind the caller's back is a
 * different model from the one they meant, billed to a different plan, and
 * nothing in the reply says so. The app's own composer always sends a model,
 * so this only refuses callers that forgot.
 *
 * The sentences live here so the CLI, the MCP tools and the services refuse a
 * missing model the same way, each naming the list it can read.
 */

/** How the caller names the model: a CLI flag, or a tool/JSON field. */
export type LaunchModelSpelling = "flag" | "field";

function modelListHint(provider?: string | null): string {
  const harness = provider?.trim();
  const list = harness ? `ade chat models --provider ${harness} --text` : "ade chat models --text";
  return `\`${list}\` lists the ids; \`ade harness routes --text\` lists every model each harness can reach.`;
}

/** The refusal for a launch with no model. */
export function launchModelRequiredMessage(provider?: string | null, spelling: LaunchModelSpelling = "flag"): string {
  const ask = spelling === "flag" ? "Pass --model <id>" : "Send model (a model id)";
  return `${ask}: ADE never picks a model for an agent. ${modelListHint(provider)}`;
}

/** The next step to append to an "unknown model" refusal. */
export function unknownModelHint(provider?: string | null): string {
  return modelListHint(provider);
}

/** A provider that runs a plain terminal and therefore takes no model. */
export function launchTakesNoModel(provider: unknown): boolean {
  return provider === "shell";
}
