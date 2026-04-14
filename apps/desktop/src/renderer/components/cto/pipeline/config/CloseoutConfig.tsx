import React, { useState, useCallback, type KeyboardEvent } from "react";
import type { LinearWorkflowCloseoutPolicy } from "../../../../../shared/types/linearSync";
import { selectCls, labelCls, inputCls, textareaCls } from "../../shared/designTokens";
import {
  ISSUE_STATE_LABELS,
  ARTIFACT_MODE_LABELS,
  REVIEW_READY_WHEN_LABELS,
  fieldLabel,
  fieldDescription,
} from "../pipelineLabels";
import { cn } from "../../../ui/cn";

type Props = {
  closeout: LinearWorkflowCloseoutPolicy;
  onUpdate: (partial: Partial<LinearWorkflowCloseoutPolicy>) => void;
};

function StateDropdown({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <p className="mb-2 text-[10px] text-muted-fg/35">{description}</p>
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(ISSUE_STATE_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v.displayName}</option>
        ))}
      </select>
    </div>
  );
}

function LabelChipInput({
  items,
  onUpdate,
}: {
  items: string[];
  onUpdate: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && draft.trim()) {
        e.preventDefault();
        if (!items.includes(draft.trim())) {
          onUpdate([...items, draft.trim()]);
        }
        setDraft("");
      }
      if (e.key === "Backspace" && !draft && items.length) {
        onUpdate(items.slice(0, -1));
      }
    },
    [draft, items, onUpdate],
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(21,26,35,0.92),rgba(14,18,26,0.94))] px-3 py-2 transition-all duration-200 focus-within:border-[rgba(167,139,250,0.45)]">
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[#34D399]"
          style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.13)" }}
        >
          {item}
          <button
            type="button"
            onClick={() => onUpdate(items.filter((_, j) => j !== i))}
            className="ml-0.5 opacity-60 hover:opacity-100"
          >
            &times;
          </button>
        </span>
      ))}
      <input
        className="min-w-[80px] flex-1 bg-transparent text-sm text-fg placeholder:text-muted-fg/36 outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        placeholder={items.length ? "" : "Type a label, press Enter"}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-white/[0.04] pt-3 mt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-fg/40">
          {title}
        </span>
        <span className="text-[9px] text-muted-fg/25">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}

export function CloseoutConfig({ closeout, onUpdate }: Props) {
  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-fg/70">Closeout</div>

      {/* Essential: success / failure states */}
      <div className="grid grid-cols-2 gap-4">
        <StateDropdown
          label={fieldLabel("closeout.successState")}
          description={fieldDescription("closeout.successState")}
          value={closeout.successState ?? "in_review"}
          onChange={(v) => onUpdate({ successState: v })}
        />
        <StateDropdown
          label={fieldLabel("closeout.failureState")}
          description={fieldDescription("closeout.failureState")}
          value={closeout.failureState ?? "blocked"}
          onChange={(v) => onUpdate({ failureState: v })}
        />
      </div>

      {/* Essential: success / failure comments (moved from Advanced) */}
      <div>
        <label className={labelCls}>{fieldLabel("closeout.successComment")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("closeout.successComment")}</p>
        <input
          className={inputCls}
          value={closeout.successComment ?? ""}
          onChange={(e) => onUpdate({ successComment: e.target.value || null })}
          placeholder="Comment posted to the Linear issue when workflow succeeds"
        />
      </div>
      <div>
        <label className={labelCls}>{fieldLabel("closeout.failureComment")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("closeout.failureComment")}</p>
        <input
          className={inputCls}
          value={closeout.failureComment ?? ""}
          onChange={(e) => onUpdate({ failureComment: e.target.value || null })}
          placeholder="Comment posted to the Linear issue when workflow fails"
        />
      </div>

      {/* Advanced */}
      <Section title="Advanced">
        <div>
          <label className={labelCls}>{fieldLabel("closeout.applyLabels")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("closeout.applyLabels")}</p>
          <LabelChipInput
            items={closeout.applyLabels ?? []}
            onUpdate={(labels) => onUpdate({ applyLabels: labels })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={closeout.resolveOnSuccess ?? false}
              onChange={(e) => onUpdate({ resolveOnSuccess: e.target.checked })}
              className="accent-[#34D399]"
            />
            <span className="text-xs text-fg/60">{fieldLabel("closeout.resolveOnSuccess")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={closeout.reopenOnFailure ?? false}
              onChange={(e) => onUpdate({ reopenOnFailure: e.target.checked })}
              className="accent-[#FB7185]"
            />
            <span className="text-xs text-fg/60">{fieldLabel("closeout.reopenOnFailure")}</span>
          </label>
        </div>
      </Section>

      {/* Expert */}
      <Section title="Expert">
        <div>
          <label className={labelCls}>{fieldLabel("closeout.commentTemplate")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">
            {"Template for the comment ADE posts on the Linear issue. Supports {{issue.title}}, {{run.status}}, {{pr.url}} placeholders."}
          </p>
          <textarea
            className={cn(textareaCls, "min-h-[60px]")}
            value={closeout.commentTemplate ?? ""}
            onChange={(e) => onUpdate({ commentTemplate: e.target.value || null })}
            placeholder={"{{issue.title}} completed by ADE"}
          />
        </div>
        <div>
          <label className={labelCls}>{fieldLabel("closeout.reviewReadyWhen")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("closeout.reviewReadyWhen")}</p>
          <select
            className={selectCls}
            value={closeout.reviewReadyWhen ?? "work_complete"}
            onChange={(e) => onUpdate({ reviewReadyWhen: e.target.value as "work_complete" | "pr_created" | "pr_ready" })}
          >
            {Object.entries(REVIEW_READY_WHEN_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.displayName}</option>
            ))}
          </select>
        </div>
      </Section>
    </div>
  );
}
