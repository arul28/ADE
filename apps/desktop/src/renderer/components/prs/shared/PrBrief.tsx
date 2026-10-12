import { memo, useContext, useMemo, type ReactNode } from "react";
import { CheckCircle, Eye, GitDiff, Question, Scales, type Icon } from "@phosphor-icons/react";

import {
  parsePrBrief,
  prBriefEvidenceCounts,
  prBriefEvidenceSummary,
  prBriefPlaceholder,
  type PrBrief,
  type PrBriefPart,
  type PrBriefPartKind,
} from "../../../../shared/prBrief";
import { COLORS } from "../../lanes/laneDesignTokens";
import { PrMarkdown } from "./PrMarkdown";
import { PrMarkdownEnvContext, PrQuoteSourceContext } from "./prMarkdownContext";
import { PrAddToChatButton } from "./PrProofMedia";

/**
 * A PR description drawn as a Brief (see `shared/prBrief.ts`): the lead, then
 * one labelled part per question a reader has. A description that is not a
 * Brief renders as the plain document it is.
 *
 * Colour carries meaning only: the part that says what was NOT checked is the
 * one a reader must not skim past, so it alone is tinted.
 */

const PART_GLYPH: Record<PrBriefPartKind, Icon | null> = {
  why: Question,
  changed: GitDiff,
  evidence: CheckCircle,
  not_checked: Eye,
  choices: Scales,
  other: null,
};

function partTone(kind: PrBriefPartKind): string {
  return kind === "not_checked" ? COLORS.warning : COLORS.textMuted;
}

function BriefPart({
  part,
  repoOwner,
  repoName,
  from,
}: {
  part: PrBriefPart;
  repoOwner: string;
  repoName: string;
  /** "the description". */
  from: string;
}) {
  const env = useContext(PrMarkdownEnvContext);
  const Glyph = PART_GLYPH[part.kind];
  const tone = partTone(part.kind);
  const summary = useMemo(
    () => (part.kind === "evidence" ? prBriefEvidenceSummary(prBriefEvidenceCounts(part.body)) : null),
    [part.body, part.kind],
  );
  // Evidence that still says "pending" proves nothing yet; say so beside it.
  const notFinal = useMemo(
    () => (part.kind === "evidence" ? prBriefPlaceholder(part.body) : null),
    [part.body, part.kind],
  );
  const source = `the "${part.heading}" part of ${from}`;
  const addToChat = env?.onAddToChat;
  const caution = part.kind === "not_checked";
  return (
    <section
      data-testid="pr-brief-part"
      data-part={part.kind}
      className="group/part relative"
      style={caution ? {
        // The one tinted part: a reader must see what was left unchecked.
        background: `color-mix(in srgb, ${COLORS.warning} 6%, transparent)`,
        borderRadius: 10,
        padding: "8px 12px 10px",
        margin: "0 -12px",
      } : undefined}
    >
      <header className="mb-1.5 flex min-h-[20px] items-center gap-1.5">
        {Glyph ? <Glyph size={13} weight={part.kind === "evidence" ? "fill" : "bold"} style={{ color: tone, flexShrink: 0 }} /> : null}
        <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tone }}>
          {part.heading}
        </h3>
        {notFinal ? (
          <span
            data-testid="pr-brief-not-final"
            title={`The text still says "${notFinal}".`}
            className="rounded-[5px] px-1.5 text-[10.5px] font-medium leading-[1.6]"
            style={{ color: COLORS.warning, background: `color-mix(in srgb, ${COLORS.warning} 12%, transparent)` }}
          >
            Not final
          </span>
        ) : null}
        {summary ? (
          <span className="text-[11px]" style={{ color: COLORS.textDim }} data-testid="pr-brief-evidence-kinds">
            · {summary}
          </span>
        ) : null}
        <span className="flex-1" />
        {addToChat && part.body.trim() ? (
          <PrAddToChatButton
            onClick={() => addToChat({ text: part.body, from: source })}
            className="opacity-0 group-hover/part:opacity-100 focus-visible:opacity-100"
          />
        ) : null}
      </header>
      {part.body.trim() ? (
        <PrQuoteSourceContext.Provider value={source}>
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} variant="document">
            {part.body}
          </PrMarkdown>
        </PrQuoteSourceContext.Provider>
      ) : (
        <p className="m-0 text-[13px] italic" style={{ color: COLORS.textMuted }}>Nothing written.</p>
      )}
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[12px]" style={{ color: COLORS.textMuted }}>{children}</p>;
}

function PrBriefParts({ brief, repoOwner, repoName, from }: { brief: PrBrief; repoOwner: string; repoName: string; from: string }) {
  const kinds = new Set(brief.parts.map((part) => part.kind));
  return (
    <div data-testid="pr-brief" className="flex flex-col gap-5">
      {brief.lead ? (
        <PrQuoteSourceContext.Provider value={from}>
          <div data-testid="pr-brief-lead" className="text-[14.5px]">
            <PrMarkdown repoOwner={repoOwner} repoName={repoName} variant="document">
              {brief.lead}
            </PrMarkdown>
          </div>
        </PrQuoteSourceContext.Provider>
      ) : null}
      {brief.parts.map((part, index) => (
        <BriefPart key={`${part.heading}:${index}`} part={part} repoOwner={repoOwner} repoName={repoName} from={from} />
      ))}
      {!kinds.has("evidence") ? (
        <Quiet>
          <span data-testid="pr-brief-no-evidence">The author did not say how this was checked.</span>
        </Quiet>
      ) : null}
      {brief.footer ? (
        <div className="text-[11.5px] opacity-70" data-testid="pr-brief-footer">
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
            {brief.footer}
          </PrMarkdown>
        </div>
      ) : null}
    </div>
  );
}

/** The description of a pull request: a Brief when it is one, else the text. */
export const PrDescriptionBody = memo(function PrDescriptionBody({
  body,
  repoOwner,
  repoName,
}: {
  body: string;
  repoOwner: string;
  repoName: string;
}) {
  const brief = useMemo(() => parsePrBrief(body), [body]);
  const from = "the description";
  const addToChat = useContext(PrMarkdownEnvContext)?.onAddToChat;
  if (brief) return <PrBriefParts brief={brief} repoOwner={repoOwner} repoName={repoName} from={from} />;
  return (
    <PrQuoteSourceContext.Provider value={from}>
      <div className="group/part relative">
        <PrMarkdown repoOwner={repoOwner} repoName={repoName} variant="document">
          {body}
        </PrMarkdown>
        {addToChat ? (
          <PrAddToChatButton
            onClick={() => addToChat({ text: body, from })}
            className="absolute right-0 top-0 opacity-0 group-hover/part:opacity-100 focus-visible:opacity-100"
          />
        ) : null}
      </div>
    </PrQuoteSourceContext.Provider>
  );
});
