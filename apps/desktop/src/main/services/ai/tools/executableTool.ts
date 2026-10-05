import type { z, ZodType } from "zod";

export type ExecutableTool<Schema extends ZodType = ZodType, Result = unknown> = {
  description: string;
  inputSchema: Schema;
  execute: (args: z.infer<Schema>) => Promise<Result> | Result;
  needsApproval?: boolean;
  /**
   * How long ADE waits for this tool before answering the model that it gave
   * up, when the default (`DEFAULT_ADE_TOOL_BUDGET_MS`) is too short — a call
   * to another machine, say. Time on an approval card does not count.
   */
  budgetMs?: number | ((args: z.infer<Schema>) => number);
};

export function executableTool<Schema extends ZodType, Result>(
  definition: ExecutableTool<Schema, Result>,
): ExecutableTool<Schema, Result> {
  return definition;
}
