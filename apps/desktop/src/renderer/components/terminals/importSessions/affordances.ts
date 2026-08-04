import { shortenExternalSessionCwd } from "../../../../shared/externalSessionAffordances";
import { abbreviateHome } from "../../../lib/pathUtils";

export {
  externalSessionImportAffordances as importAffordancesFor,
} from "../../../../shared/externalSessionAffordances";
export type {
  ImportAffordance,
  ImportAffordanceKind,
  ImportMode,
  ImportTarget,
} from "../../../../shared/externalSessionAffordances";

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
