import type { z, ZodType } from "zod";

export type ExecutableTool<Schema extends ZodType = ZodType, Result = unknown> = {
  description: string;
  inputSchema: Schema;
  execute: (args: z.infer<Schema>) => Promise<Result> | Result;
  needsApproval?: boolean;
};

export function executableTool<Schema extends ZodType, Result>(
  definition: ExecutableTool<Schema, Result>,
): ExecutableTool<Schema, Result> {
  return definition;
}
