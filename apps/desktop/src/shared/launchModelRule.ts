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

/** How the caller names the model: the CLI flag, or the tool/JSON field it sends. */
export type LaunchModelSpelling = "--model" | "model" | "modelId";

/** The commands that list model ids, as the next step of any model refusal. */
export function unknownModelHint(provider?: string | null): string {
  const harness = provider?.trim();
  const list = harness ? `ade chat models --provider ${harness} --text` : "ade chat models --text";
  return `\`${list}\` lists the ids; \`ade harness routes --text\` lists every model each harness can reach.`;
}

function askFor(spelling: LaunchModelSpelling): string {
  return spelling === "--model" ? "Pass --model <id>" : `Send ${spelling} (a model id)`;
}

/** The refusal for a launch with no model. */
export function launchModelRequiredMessage(provider?: string | null, spelling: LaunchModelSpelling = "--model"): string {
  return `${askFor(spelling)}: ADE never picks a model for an agent. ${unknownModelHint(provider)}`;
}

/**
 * The refusal for a webhook automation with no model: each delivery starts a
 * chat, unless deliveries go into an existing chat instead.
 */
export function webhookModelRequiredMessage(spelling: "flag" | "field"): string {
  const into = spelling === "flag" ? "--in-this-chat or --chat <id>" : "chatSessionId";
  return `${askFor(spelling === "flag" ? "--model" : "modelId")} for the chat each delivery starts, or ${into} to send deliveries into a chat. ${unknownModelHint()}`;
}

/** A provider that runs a plain terminal and therefore takes no model. */
export function launchTakesNoModel(provider: unknown): boolean {
  return provider === "shell";
}

/** True when a launch on `provider` names none of `models`, and the provider needs one. */
export function launchModelMissing(provider: unknown, ...models: unknown[]): boolean {
  if (launchTakesNoModel(provider)) return false;
  return !models.some((model) => typeof model === "string" && model.trim().length > 0);
}
