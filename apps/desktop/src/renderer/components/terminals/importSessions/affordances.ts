import {
  externalSessionImportAffordances,
  shortenExternalSessionCwd,
} from "../../../../shared/externalSessionAffordances";
import type { ExternalSessionSummary } from "../../../../shared/types/externalSessions";
import { abbreviateHome } from "../../../lib/pathUtils";

export type {
  ImportAffordance,
  ImportAffordanceKind,
  ImportMode,
  ImportTarget,
} from "../../../../shared/externalSessionAffordances";

const FORK_AS_CHAT_DESCRIPTION =
  "Creates a new ADE chat from this session. Pick any SDK-backed catalog model — same family uses a native fork; other families replay the full transcript verbatim.";
const FORK_AS_CHAT_MODEL_HINT =
  "Any catalog model works. Oldest turns drop only if the transcript exceeds the target context window.";

export function importAffordancesFor(summary: ExternalSessionSummary) {
  return externalSessionImportAffordances(summary).map((action) => {
    if (action.kind !== "fork-as-chat") return action;
    return {
      ...action,
      description: FORK_AS_CHAT_DESCRIPTION,
      hint: [action.hint, FORK_AS_CHAT_MODEL_HINT].filter(Boolean).join(" "),
    };
  });
}

/**
 * Renderer binding for the path shortener. `~` has to mean the same thing here
 * as it does everywhere else in the renderer, so the home rule comes from
 * `lib/pathUtils` rather than from a second copy inside the shared module.
 */
export function shortenCwd(
  cwd: string | null | undefined,
  maxSegments?: number,
): string {
  return shortenExternalSessionCwd(cwd, { maxSegments, abbreviateHome });
}
