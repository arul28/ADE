// Display labels for `@pr:` and `@mac:` chips in SENT messages.
//
// A sent message keeps only the token (`@pr:<ADE row id>`), so without help
// the transcript can only print "PR 3f2a1b9c". Labels come from data the
// renderer already reads, cheapest first:
//   1. labels remembered from @-menu suggestions this session (free);
//   2. PRs: the chat machine's PR list (`listPrsCoalesced`, one coalesced
//      read), which also yields the number/repo a click needs;
//   3. machines: one account directory read per app session, only when a
//      machine chip has no remembered label.
// Unknown stays the chip's short-id label; nothing here throws.

import { useEffect, useMemo, useState } from "react";

import { formatChatMentionToken } from "../../../shared/chatMentions";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { findMachineByMentionId } from "../../../shared/accountMachineSnapshot";
import type { Chip } from "../../../shared/chips";
import type { DeeplinkPrTarget } from "../../../shared/deeplinks";
import type { OpenProjectBinding, PrSummary } from "../../../shared/types";
import type { ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { fetchAccountMachines } from "../../lib/account";

const rememberedLabels = new Map<string, string>();
const MAX_REMEMBERED = 500;

/** Keep PR and machine labels from @-menu results for later transcript chips. */
export function rememberMentionSuggestionLabels(suggestions: readonly ChatMentionSuggestion[]): void {
  for (const suggestion of suggestions) {
    if (suggestion.kind !== "pr" && suggestion.kind !== "machine" && suggestion.kind !== "mcp") continue;
    const token = formatChatMentionToken(suggestion.kind, suggestion.id);
    rememberedLabels.delete(token);
    rememberedLabels.set(token, suggestion.title);
  }
  while (rememberedLabels.size > MAX_REMEMBERED) {
    const oldest = rememberedLabels.keys().next().value;
    if (oldest === undefined) break;
    rememberedLabels.delete(oldest);
  }
}

export type MentionChipResolution = {
  label: string | null;
  /** Where a PR chip click goes, once the PR row is known. */
  prTarget: DeeplinkPrTarget | null;
};

const NONE: MentionChipResolution = { label: null, prTarget: null };

function prResolution(pr: PrSummary): MentionChipResolution {
  return {
    label: `#${pr.githubPrNumber} ${pr.title?.trim() || "Untitled pull request"}`,
    prTarget: {
      kind: "pr",
      prNumber: pr.githubPrNumber,
      ...(pr.repoOwner && pr.repoName ? { repoOwner: pr.repoOwner, repoName: pr.repoName } : {}),
    },
  };
}

/** Label (and PR click target) for a `@pr:` / `@mac:` chip; `NONE` for any other chip. */
export function useMentionChipResolution(
  chip: Chip,
  scope: { pin: OpenProjectBinding | null; rootPath: string | null },
): MentionChipResolution {
  const source = chip.source;
  const mention = source.origin === "mention" && (source.mentionKind === "pr" || source.mentionKind === "machine" || source.mentionKind === "mcp")
    ? { kind: source.mentionKind, id: source.id }
    : null;
  const remembered = mention ? rememberedLabels.get(chip.token) ?? null : null;
  const [resolved, setResolved] = useState<MentionChipResolution>(NONE);
  const pinKey = scope.pin?.key ?? null;

  useEffect(() => {
    if (!mention) return;
    // A remembered machine label is all a machine chip needs; a PR chip still
    // reads its row so a click knows the number and repo.
    if ((mention.kind === "machine" || mention.kind === "mcp") && remembered) return;
    let cancelled = false;
    const load = mention.kind === "pr"
      ? listPrsCoalesced({ pin: scope.pin, projectRoot: scope.rootPath })
        .then((prs) => {
          const pr = prs.find((entry) => entry.id === mention.id);
          return pr ? prResolution(pr) : NONE;
        })
      : mention.kind === "mcp" ? Promise.resolve(NONE) : fetchAccountMachines().then((result) => {
          const machine = result.state === "ok" ? findMachineByMentionId(result.machines, mention.id) : null;
          const name = machine ? accountMachineDisplayName(machine) : null;
          return name ? { label: name, prTarget: null } : NONE;
        });
    void load.catch(() => NONE).then((next) => {
      if (!cancelled) setResolved(next);
    });
    return () => {
      cancelled = true;
    };
    // `mention` is derived from the memoized chip; key on its identity fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.kind, mention?.id, remembered, pinKey, scope.rootPath]);

  const isMention = mention !== null;
  return useMemo(
    () => (isMention ? { label: resolved.label ?? remembered, prTarget: resolved.prTarget } : NONE),
    [isMention, resolved, remembered],
  );
}
