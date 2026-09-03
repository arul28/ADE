/**
 * Mostly moved to `@ade-dev/ui`.
 *
 * The label helpers are pure formatting over fields a plugin page reads out of
 * the replicated `plugin_*` tables, so they belong in the kit.
 * `toLaneLinearIssue` does not: it converts between two of the app's own wire
 * shapes and drags the issue-ref and branch-name modules with it, none of which
 * a page has any use for. It stays here.
 */

import type { LaneLinearIssue, NormalizedLinearIssue } from "../../../shared/types";
import { normalizedLinearIssueToLaneIssue } from "../../../shared/laneLinearIssue";

export {
  branchExistsForLinearIssue,
  issueProjectLabel,
  issueUpdatedLabel,
  linearPriorityLabel,
} from "@ade-dev/ui";

export function toLaneLinearIssue(issue: NormalizedLinearIssue): LaneLinearIssue {
  return normalizedLinearIssueToLaneIssue(issue);
}
