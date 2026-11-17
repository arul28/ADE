import type { SearchIndexStatus, SearchQueryArgs, SearchQueryResult, SearchRebuildResult } from "../../../shared/types/search";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

/**
 * Universal search on the web. The palette asks every online copy of the
 * repository (`useUniversalSearch`); the federated adapter sends each pinned
 * call to that computer's brain (`search.query`). The cloud rows this page
 * already loaded (saved chats, saved terminals, cloud lanes) are in the Work
 * union, which the palette matches on its own. Nothing extra is stored.
 *
 * A brain without the command (an older ADE) answers null: the palette skips
 * that computer, as it does for a client with no search.
 */
export function createSearchNamespace(infra: AdapterInfra): AdeNamespace<"search"> {
  const { commands } = infra;
  return {
    query: async (args: SearchQueryArgs, pin?: RuntimePinArg): Promise<SearchQueryResult> => {
      assertWebRuntimePinRoutable("search.query", pin, infra);
      if (!commands.hasAction("search.query")) return null as unknown as SearchQueryResult;
      return await commands.call<SearchQueryResult>("search.query", args as unknown as Record<string, unknown>, {
        fallback: () => null as unknown as SearchQueryResult,
      });
    },
    indexStatus: async (pin?: RuntimePinArg): Promise<SearchIndexStatus | null> => {
      assertWebRuntimePinRoutable("search.indexStatus", pin, infra);
      if (!commands.hasAction("search.indexStatus")) return null;
      return await commands.call<SearchIndexStatus | null>("search.indexStatus", {}, { fallback: null });
    },
    // Rebuilding a computer's index is a desktop action (Settings), not a web one.
    rebuildIndex: async (pin?: RuntimePinArg): Promise<SearchRebuildResult> => {
      assertWebRuntimePinRoutable("search.rebuildIndex", pin, infra);
      return { started: false };
    },
  };
}
