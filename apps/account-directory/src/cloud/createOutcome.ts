import type { CloudInstance } from "./contract";
import { fail, json } from "./http";

/**
 * How a computer create ended, shared by the create route (`routes.ts`) and
 * the server launcher (`launches.ts`), so neither imports the other.
 */

/** A repeated request id: the computer that request made, or a create still in flight. */
export type ReplayOutcome = { kind: "replayed"; instance: CloudInstance } | { kind: "in_progress" };

/**
 * How a create ended, for a caller inside the server (the launcher) that acts
 * on it without decoding HTTP: `made` by this call (`answer` is the route's
 * 201 body), `replayed` (an earlier request with the same id made it), a
 * create still `in_progress`, or `refused` with the route's own answer.
 */
export type CreateComputerOutcome =
  | { kind: "made"; instance: CloudInstance; answer: unknown }
  | ReplayOutcome
  | { kind: "refused"; response: Response };

/**
 * What the server itself adds to a create made for one of its own flows (the
 * server launcher): env the client could not set, and statements that land in
 * the adoption's batch, so they hold exactly when the computer was made.
 */
export type CreateComputerExtras = {
  body: Record<string, unknown>;
  serverEnv?: Record<string, string>;
  onMade?: (instance: CloudInstance) => D1PreparedStatement[];
};

export const createInProgress = () => fail("create_in_progress", "ADE Cloud is still making this computer. Try again in a moment.", 409);

/** The route's answer for a create's outcome: 201, 200 for a replay, 409 while one is in flight, or the refusal. */
export function createAnswerOf(outcome: CreateComputerOutcome): Response {
  if (outcome.kind === "made") return json(outcome.answer, 201);
  if (outcome.kind === "replayed") return json(outcome.instance, 200);
  if (outcome.kind === "in_progress") return createInProgress();
  return outcome.response;
}
