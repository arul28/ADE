import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  JevChoiceQuestion,
  JevDecideRequest,
} from "../../../shared/types/jev";
import {
  PALETTE_SUGGESTION_CACHE_LIMIT,
  PALETTE_SUGGESTION_DEBOUNCE_MS,
  PALETTE_SUGGESTION_PROBABILITY_FLOOR,
  PALETTE_SUGGESTION_TOP_PROBABILITY_FLOOR,
  paletteSuggestionCandidates,
  paletteSuggestionDescription,
  type PaletteSuggestionCacheEntry,
  type PaletteSuggestionCommand,
  type PaletteSuggestionResult,
} from "./commandPaletteSuggestions";
import { shiftSelectedIndexForSuggestions } from "./commandPaletteSections";

type UsePaletteSuggestionsArgs<C extends PaletteSuggestionCommand> = {
  open: boolean;
  /** Suggestions only run in the palette's default mode. */
  mode: string;
  q: string;
  commands: C[];
  /** The commands the typed query already matches. */
  filtered: C[];
  parsedWorkQuery: {
    terms: readonly string[];
    filterTokens: readonly unknown[];
    tracked: unknown;
  };
  pathname: string;
  selectedLaneId: string | null;
  selectedLaneName: string | undefined;
  isFocusedChat: boolean;
  focusedChatId: string | undefined;
  runtimePinKey: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** Rows of normal results, which the suggested rows shift in front of. */
  normalFlatCountRef: MutableRefObject<number>;
  setSelectedIdx: Dispatch<SetStateAction<number>>;
};

/**
 * Jev's "Suggested" commands for a plain-English query: a debounced
 * `jevDecide` over the best-scoring candidates, cached per query. Results are
 * only shown while the query and context still match what was asked.
 */
export function usePaletteSuggestions<C extends PaletteSuggestionCommand>({
  open,
  mode,
  q,
  commands,
  filtered,
  parsedWorkQuery,
  pathname,
  selectedLaneId,
  selectedLaneName,
  isFocusedChat,
  focusedChatId,
  runtimePinKey,
  runtimePinRef,
  normalFlatCountRef,
  setSelectedIdx,
}: UsePaletteSuggestionsArgs<C>): C[] {
  const [suggestionResult, setSuggestionResult] =
    useState<PaletteSuggestionResult | null>(null);
  const suggestionCacheRef = useRef(new Map<string, PaletteSuggestionCacheEntry>());
  const suggestionContext = [
    pathname,
    selectedLaneId ?? "no-lane",
    isFocusedChat ? `chat:${focusedChatId ?? "focused"}` : "no-chat",
    runtimePinKey ?? "unbound",
  ].join("\u001f");
  const suggestionResultRef = useRef(suggestionResult);
  suggestionResultRef.current = suggestionResult;
  const suggestedCommands = useMemo<C[]>(() => {
    if (
      !open ||
      mode !== "default" ||
      !suggestionResult ||
      suggestionResult.query !== q.trim() ||
      suggestionResult.context !== suggestionContext
    ) {
      return [];
    }
    const byId = new Map(commands.map((command) => [command.id, command]));
    return suggestionResult.commandIds
      .map((id) => byId.get(id))
      .filter((command): command is C => command != null);
  }, [commands, mode, open, q, suggestionContext, suggestionResult]);

  useEffect(() => {
    const query = q.trim();
    const wordCount = query.split(/\s+/).filter(Boolean).length;
    const plainEnglishQuery =
      wordCount >= 3 || (wordCount >= 2 && filtered.length === 0);
    if (
      !open ||
      mode !== "default" ||
      !query ||
      !plainEnglishQuery ||
      parsedWorkQuery.filterTokens.length > 0 ||
      parsedWorkQuery.tracked !== null
    ) {
      setSuggestionResult(null);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const candidates = paletteSuggestionCandidates(
        commands,
        filtered,
        parsedWorkQuery.terms,
      );
      if (candidates.length < 2) {
        setSuggestionResult(null);
        return;
      }

      const criteria = Object.fromEntries(
        candidates.map((command) => [
          command.id,
          paletteSuggestionDescription(command),
        ]),
      );
      const state = [
        `User query: ${query}`,
        `Current tab: ${pathname}`,
        `Focused lane: ${selectedLaneName ?? "none"}`,
        `Chat focused: ${isFocusedChat ? "yes" : "no"}`,
      ].join("\n");
      const requestKey = JSON.stringify({ state, criteria });
      const applySuggestions = (commandIds: string[]) => {
        if (cancelled) return;
        const availableIds = commandIds
          .filter((id) => candidates.some((command) => command.id === id))
          .slice(0, 3);
        if (availableIds.length === 0) {
          setSuggestionResult(null);
          return;
        }

        const previous = suggestionResultRef.current;
        const alreadyVisible =
          previous?.query === query &&
          previous.context === suggestionContext &&
          previous.commandIds.join("\u001f") === availableIds.join("\u001f");
        if (!alreadyVisible) {
          setSelectedIdx((current) =>
            shiftSelectedIndexForSuggestions({
              current,
              previous,
              query,
              context: suggestionContext,
              nextCount: availableIds.length,
              normalCount: normalFlatCountRef.current,
            }),
          );
        }
        setSuggestionResult({
          query,
          context: suggestionContext,
          commandIds: availableIds,
        });
      };
      const cacheResult = (commandIds: string[]) => {
        suggestionCacheRef.current.delete(query);
        suggestionCacheRef.current.set(query, { requestKey, commandIds });
        while (suggestionCacheRef.current.size > PALETTE_SUGGESTION_CACHE_LIMIT) {
          const oldest = suggestionCacheRef.current.keys().next().value;
          if (oldest == null) break;
          suggestionCacheRef.current.delete(oldest);
        }
      };

      const cached = suggestionCacheRef.current.get(query);
      if (cached?.requestKey === requestKey) {
        applySuggestions(cached.commandIds);
        return;
      }

      const request: JevDecideRequest<{ command: JevChoiceQuestion }> = {
        feature: "palette",
        state,
        priority: "interactive",
        questions: {
          command: {
            type: "choice",
            instructions:
              "Choose the ADE command that best matches the user's request. Use the current tab and focused lane or chat as context.",
            criteria,
          },
        },
      };
      void window.ade.ai
        .jevDecide(request, runtimePinRef.current)
        .then((answers) => {
          if (cancelled) return;
          const answer = answers?.command;
          const ranked =
            answer?.type === "choice"
              ? Object.entries(answer.probabilities)
                  .filter(([id, probability]) =>
                    candidates.some((command) => command.id === id) &&
                    Number.isFinite(probability),
                  )
                  .sort((left, right) => right[1] - left[1])
              : [];
          const commandIds =
            ranked[0]?.[1] != null &&
            ranked[0][1] >= PALETTE_SUGGESTION_TOP_PROBABILITY_FLOOR
              ? ranked
                  .filter(([, probability]) =>
                    probability > PALETTE_SUGGESTION_PROBABILITY_FLOOR,
                  )
                  .slice(0, 3)
                  .map(([id]) => id)
              : [];
          cacheResult(commandIds);
          applySuggestions(commandIds);
        })
        .catch(() => {
          if (cancelled) return;
          cacheResult([]);
          setSuggestionResult(null);
        });
    }, PALETTE_SUGGESTION_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    commands,
    filtered,
    isFocusedChat,
    pathname,
    mode,
    open,
    parsedWorkQuery.filterTokens.length,
    parsedWorkQuery.terms,
    parsedWorkQuery.tracked,
    q,
    runtimePinKey,
    runtimePinRef,
    normalFlatCountRef,
    setSelectedIdx,
    selectedLaneName,
    suggestionContext,
  ]);

  return suggestedCommands;
}

