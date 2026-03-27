import React from "react";
import { Plus } from "@phosphor-icons/react";
import { STAGE_COLORS } from "./pipelineLabels";

type Props = {
  onAddStage?: () => void;
  /** Color of the stage card to the left of this connector. */
  leftColor?: string;
  /** Color of the stage card to the right of this connector. */
  rightColor?: string;
  /** Whether the pipeline has multiple stages (makes line slightly thicker). */
  multiStage?: boolean;
};

export function StageConnector({ onAddStage, leftColor, rightColor, multiStage }: Props) {
  const left = leftColor ?? "rgba(255,255,255,0.12)";
  const right = rightColor ?? "rgba(255,255,255,0.12)";
  const lineHeight = multiStage ? "h-[2px]" : "h-px";

  return (
    <div className="flex items-center self-center shrink-0">
      {/* Left line -- gradient from left color */}
      <div
        className={`${lineHeight} w-5 rounded-full`}
        style={{ background: `linear-gradient(90deg, ${left}60, ${left}30)` }}
      />

      {/* Add stage button */}
      {onAddStage ? (
        <button
          type="button"
          onClick={onAddStage}
          className="group/conn flex h-5 w-5 items-center justify-center rounded-full transition-all duration-200 hover:scale-110"
          style={{
            background: "rgba(19,24,34,0.9)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
          title="Add stage"
        >
          <Plus
            size={9}
            className="text-muted-fg/40 transition-colors duration-200 group-hover/conn:text-fg"
          />
        </button>
      ) : (
        <div
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "rgba(255,255,255,0.12)" }}
        />
      )}

      {/* Right line -- gradient toward right color */}
      <div
        className={`${lineHeight} w-5 rounded-full`}
        style={{ background: `linear-gradient(90deg, ${right}30, ${right}60)` }}
      />
    </div>
  );
}
