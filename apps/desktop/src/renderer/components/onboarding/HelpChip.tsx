import React, { useCallback, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { findTerm } from "../../onboarding/glossary";
import { GlossaryPopover } from "./GlossaryPopover";
import { useOnboardingStore } from "../../state/onboardingStore";

type HelpChipProps = {
  termId: string;
  side?: "top" | "bottom" | "left" | "right";
};

export function HelpChip({ termId, side = "bottom" }: HelpChipProps) {
  const onboardingEnabled = useAppStore((s) => s.onboardingEnabled);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const term = findTerm(termId);

  const handleClick = useCallback(() => {
    setOpen((v) => !v);
    const ade = (typeof window !== "undefined" ? (window as any).ade : undefined) as
      | { onboarding?: Window["ade"]["onboarding"] }
      | undefined;
    const onboarding = ade?.onboarding ?? null;
    if (onboarding && term) {
      // Fire-and-forget. The store will pick up the fresh progress via subsequent refreshes.
      onboarding
        .markGlossaryTermSeen(termId)
        .then((progress) => {
          useOnboardingStore.setState({ progress });
        })
        .catch(() => {
          /* ignore */
        });
    }
  }, [term, termId]);

  if (!onboardingEnabled) return null;

  if (!term) {
    if (typeof console !== "undefined") {
      console.warn(`[HelpChip] no glossary term registered for id="${termId}"`);
    }
    return null;
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`What is ${term.term}?`}
        aria-expanded={open}
        onClick={handleClick}
        className="ade-help-chip"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          marginLeft: 6,
          padding: 0,
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          cursor: "pointer",
          background: "rgba(255, 255, 255, 0.06)",
          color: "var(--color-muted-fg, #908FA0)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
        }}
      >
        ?
      </button>
      {open && buttonRef.current ? (
        <GlossaryPopover
          term={term}
          anchor={buttonRef.current}
          side={side}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
