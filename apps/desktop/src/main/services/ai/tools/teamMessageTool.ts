import { z } from "zod";
import { tool } from "ai";

export function createTeamMessageTool(opts: {
  sendCallback: (args: { target: string; message: string; fromAttemptId: string }) => Promise<void>;
  currentAttemptId: string;
}) {
  return tool({
    description:
      "Send a message to another agent or the orchestrator. Use @step-key to target a specific agent, @orchestrator for the orchestrator, or @all for broadcast.",
    inputSchema: z.object({
      target: z.string().describe("Target: step-key, 'orchestrator', or 'all'"),
      message: z.string().describe("The message content"),
    }),
    execute: async ({ target, message }) => {
      await opts.sendCallback({
        target,
        message,
        fromAttemptId: opts.currentAttemptId,
      });
      return { delivered: true, target };
    },
  });
}
