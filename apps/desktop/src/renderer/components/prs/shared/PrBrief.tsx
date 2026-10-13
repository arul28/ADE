import { memo, useContext, useMemo } from "react";
import {
  parsePrBrief,
  prBriefPlaceholder,
  type PrBrief,
  type PrBriefPart,
} from "../../../../shared/prBrief";
import { COLORS } from "../../lanes/laneDesignTokens";
import { PR_DOCUMENT_HEADING_CLASS, PrMarkdown } from "./PrMarkdown";
import { PrMarkdownEnvContext, PrQuoteSourceContext } from "./prMarkdownContext";
import { PrAddToChatButton } from "./PrProofMedia";

/**
 * A PR description drawn as a Brief (see `shared/prBrief.ts`).
 *
 * It looks like the document the author wrote: the same headings, the same
 * text. What the parts add is behaviour, not decoration: each part can be
 * quoted in the chat, and evidence that is still a placeholder says so.
 */
function BriefPart({
  part,
  first,
  repoOwner,
  repoName,
  from,
}: {
  part: PrBriefPart;
  /** Nothing is above it, so its heading takes no top margin. */
  first: boolean;
  repoOwner: string;
  repoName: string;
  /** "the description". */
  from: string;
}) {
  const env = useContext(PrMarkdownEnvContext);
  // Evidence that still says "pending" proves nothing yet; say so beside it.
  const notFinal = useMemo(
    () => (part.kind === "evidence" ? prBriefPlaceholder(part.body) : null),
    [part.body, part.kind],
  );
  const source = `the "${part.heading}" part of ${from}`;
  const addToChat = env?.onAddToChat;
  const Heading = `h${part.level}` as "h1" | "h2" | "h3";
  return (
    <section data-testid="pr-brief-part" data-part={part.kind} className="group/part">
      <div className={`flex items-baseline gap-2 ${PR_DOCUMENT_HEADING_CLASS[part.level]} ${first ? "!mt-0" : ""}`}>
        <Heading className="m-0 min-w-0 font-semibold leading-snug" style={{ color: COLORS.textPrimary, fontSize: "inherit" }}>
          {part.heading}
        </Heading>
        {notFinal ? (
          <span
            data-testid="pr-brief-not-final"
            title={`The text still says "${notFinal}".`}
            className="shrink-0 rounded-[5px] px-1.5 text-[10.5px] font-medium leading-[1.6] tracking-normal"
            style={{ color: COLORS.warning, background: `color-mix(in srgb, ${COLORS.warning} 12%, transparent)` }}
          >
            Not final
          </span>
        ) : null}
        <span className="flex-1" />
        {addToChat && part.body.trim() ? (
          <PrAddToChatButton
            onClick={() => addToChat({ text: part.body, from: source })}
            className="self-center tracking-normal opacity-0 group-hover/part:opacity-100 focus-visible:opacity-100"
          />
        ) : null}
      </div>
      {part.body.trim() ? (
        <PrQuoteSourceContext.Provider value={source}>
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} variant="document">
            {part.body}
          </PrMarkdown>
        </PrQuoteSourceContext.Provider>
      ) : null}
    </section>
  );
}

function PrBriefParts({ brief, repoOwner, repoName, from }: { brief: PrBrief; repoOwner: string; repoName: string; from: string }) {
  const kinds = new Set(brief.parts.map((part) => part.kind));
  return (
    <div data-testid="pr-brief">
      {brief.lead ? (
        <PrQuoteSourceContext.Provider value={from}>
          <div data-testid="pr-brief-lead">
            <PrMarkdown repoOwner={repoOwner} repoName={repoName} variant="document">
              {brief.lead}
            </PrMarkdown>
          </div>
        </PrQuoteSourceContext.Provider>
      ) : null}
      {brief.parts.map((part, index) => (
        <BriefPart
          key={`${part.heading}:${index}`}
          part={part}
          first={index === 0 && !brief.lead}
          repoOwner={repoOwner}
          repoName={repoName}
          from={from}
        />
      ))}
      {!kinds.has("evidence") ? (
        <p data-testid="pr-brief-no-evidence" className="mb-0 mt-4 text-[12px]" style={{ color: COLORS.textMuted }}>
          The author did not say how this was checked.
        </p>
      ) : null}
      {brief.footer ? (
        <div className="mt-4 text-[11.5px] opacity-70" data-testid="pr-brief-footer">
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
