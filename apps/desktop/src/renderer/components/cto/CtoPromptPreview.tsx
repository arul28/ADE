import React, { useEffect, useState } from "react";
import type {
  CtoSystemPromptPreview,
  CtoSystemPromptPreviewSection,
  OpenProjectBinding,
} from "../../../shared/types";
import { Banner } from "../ui/notice";
import { CopyButton } from "./ctoSettingsUi";
import { BRAND } from "../../../shared/brand";

/**
 * Everything the CTO is told, as the document it is: one block per part,
 * read from the CTO's home machine (`pin`). Mounted only when someone opens
 * it, so the read happens on demand.
 */

/** The host's section ids in words a person would use. */
const SECTION_TITLES: Record<CtoSystemPromptPreviewSection["id"], string> = {
  doctrine: "How it works",
  continuity: "Staying continuous",
  memory: "Notes and open work",
  knowledge: `What it knows about ${BRAND.NAME}`,
  capabilities: "What it can do",
};

export function CtoPromptPreview({ pin }: { pin: OpenProjectBinding | null }) {
  const [preview, setPreview] = useState<CtoSystemPromptPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.ade?.cto;
    if (!bridge || !pin) {
      setLoading(false);
      setPreview(null);
      setError(bridge ? "Home machine unreachable" : `Reopen ${BRAND.NAME} to reconnect`);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setError(null);
    void bridge.previewSystemPrompt(undefined, pin)
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't read the prompt.");
        setPreview(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the pin's key
  }, [pin?.key]);

  if (loading) return <p className="ade-modern-muted">Loading…</p>;
  if (error) {
    return (
      <Banner
        layout="inline"
        model={{ id: "cto-prompt-preview-error", tone: "error", title: error, report: { surface: "cto_prompt_preview" } }}
      />
    );
  }

  const sections = preview?.sections ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="cto-prompt-preview">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-[var(--kit-text-3)]">
          About <span className="kit-num">{(preview?.tokenEstimate ?? 0).toLocaleString()}</span> tokens
        </span>
        <CopyButton value={preview?.prompt ?? ""} label="Copy prompt" />
      </div>
      {sections.map((section) => (
        <section key={section.id} className="flex min-w-0 flex-col gap-1.5">
          <h4 className="m-0 text-[12.5px] font-semibold text-fg">{SECTION_TITLES[section.id] ?? section.title}</h4>
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.7] text-[var(--kit-text-2)]">
            {section.content}
          </pre>
        </section>
      ))}
    </div>
  );
}
