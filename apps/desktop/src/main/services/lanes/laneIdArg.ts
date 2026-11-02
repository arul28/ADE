import { AdeExpectedError } from "../../../shared/expectedError";

/** What a caller sent instead of the value an action wanted, for its error message. */
export function describeArgType(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Refuse a lane id an action caller (an agent, the CLI, another machine) sent
 * missing, blank or not a string, before any lookup runs with it.
 */
export function assertLaneIdArg(value: unknown, action = "This action"): asserts value is string {
  if (typeof value === "string" && value.trim()) return;
  const got = typeof value === "string" ? "an empty string" : describeArgType(value);
  throw new AdeExpectedError(
    `invalid_argument: ${action} needs a laneId (a lane id string), but got ${got}. Pass --lane <id> or run from inside a lane.`,
    "user",
  );
}
