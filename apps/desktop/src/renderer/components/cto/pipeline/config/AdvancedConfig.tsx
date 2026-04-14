import React, { useState, useCallback, type KeyboardEvent } from "react";
import type {
  LinearWorkflowRetryPolicy,
  LinearWorkflowConcurrency,
  LinearWorkflowRouting,
  LinearWorkflowObservability,
  LinearWorkflowCloseoutPolicy,
} from "../../../../../shared/types/linearSync";
import { inputCls, labelCls, selectCls, textareaCls } from "../../shared/designTokens";
import { fieldLabel, fieldDescription, ARTIFACT_MODE_LABELS } from "../pipelineLabels";
import { cn } from "../../../ui/cn";

type Props = {
  retry: LinearWorkflowRetryPolicy | undefined;
  concurrency: LinearWorkflowConcurrency | undefined;
  routing: LinearWorkflowRouting | undefined;
  observability: LinearWorkflowObservability | undefined;
  closeout?: LinearWorkflowCloseoutPolicy;
  onUpdateRetry: (patch: Partial<LinearWorkflowRetryPolicy>) => void;
  onUpdateConcurrency: (patch: Partial<LinearWorkflowConcurrency>) => void;
  onUpdateRouting: (patch: Partial<LinearWorkflowRouting>) => void;
  onUpdateObservability: (patch: Partial<LinearWorkflowObservability>) => void;
  onUpdateCloseout?: (patch: Partial<LinearWorkflowCloseoutPolicy>) => void;
};

function NumberField({
  label,
  description,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  description: string;
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <p className="mb-2 text-[10px] text-muted-fg/35">{description}</p>
      <input
        type="number"
        className={cn(inputCls, "!w-24")}
        value={value ?? ""}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        min={min}
        max={max}
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[#A78BFA]"
      />
      <span className="text-xs text-fg/60">{label}</span>
    </label>
  );
}

function TagsInput({
  items,
  onUpdate,
  placeholder,
}: {
  items: string[];
  onUpdate: (next: string[]) => void;
  placeholder: string;
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
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[#94A3B8]"
          style={{ background: "rgba(148,163,184,0.08)", border: "1px solid rgba(148,163,184,0.13)" }}
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
        placeholder={items.length ? "" : placeholder}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-white/[0.04] pt-3 mt-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-fg/40">{title}</span>
        <span className="text-[9px] text-muted-fg/25">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}

export function AdvancedConfig({
  retry,
  concurrency,
  routing,
  observability,
  closeout,
  onUpdateRetry,
  onUpdateConcurrency,
  onUpdateRouting,
  onUpdateObservability,
  onUpdateCloseout,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-fg/70">Advanced Settings</div>

      {/* Artifact & Proof -- elevated out of Expert */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-fg/40">Artifact &amp; Proof</div>
        <p className="text-[10px] text-muted-fg/35 leading-relaxed">
          ADE can attach screenshots, logs, and PR links as proof when the workflow completes.
        </p>
        {onUpdateCloseout && (
          <div>
            <label className={labelCls}>{fieldLabel("closeout.artifactMode")}</label>
            <select
              className={selectCls}
              value={closeout?.artifactMode ?? "links"}
              onChange={(e) => onUpdateCloseout({ artifactMode: e.target.value as "links" | "attachments" })}
            >
              {Object.entries(ARTIFACT_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v.displayName}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Retry: max retries */}
      <NumberField
        label={fieldLabel("retry.maxAttempts")}
        description={fieldDescription("retry.maxAttempts")}
        value={retry?.maxAttempts}
        onChange={(v) => onUpdateRetry({ maxAttempts: v })}
        min={0}
        max={10}
      />

      {/* Concurrency */}
      <div className="grid grid-cols-2 gap-4">
        <NumberField
          label={fieldLabel("concurrency.maxActiveRuns")}
          description={fieldDescription("concurrency.maxActiveRuns")}
          value={concurrency?.maxActiveRuns}
          onChange={(v) => onUpdateConcurrency({ maxActiveRuns: v })}
          min={1}
          max={50}
        />
        <NumberField
          label={fieldLabel("concurrency.perIssue")}
          description={fieldDescription("concurrency.perIssue")}
          value={concurrency?.perIssue}
          onChange={(v) => onUpdateConcurrency({ perIssue: v })}
          min={1}
          max={10}
        />
      </div>

      <Toggle
        label={fieldLabel("concurrency.dedupeByIssue")}
        checked={concurrency?.dedupeByIssue ?? false}
        onChange={(v) => onUpdateConcurrency({ dedupeByIssue: v })}
      />

      {/* Routing */}
      <Toggle
        label={fieldLabel("routing.watchOnly")}
        checked={routing?.watchOnly ?? false}
        onChange={(v) => onUpdateRouting({ watchOnly: v })}
      />

      <div>
        <label className={labelCls}>{fieldLabel("routing.metadataTags")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("routing.metadataTags")}</p>
        <TagsInput
          items={routing?.metadataTags ?? []}
          onUpdate={(tags) => onUpdateRouting({ metadataTags: tags })}
          placeholder="Route tag"
        />
      </div>

      {/* Expert */}
      <Section title="Expert">
        <div className="grid grid-cols-2 gap-4">
          <NumberField
            label={fieldLabel("retry.backoffSeconds")}
            description={fieldDescription("retry.backoffSeconds")}
            value={retry?.backoffSeconds}
            onChange={(v) => onUpdateRetry({ backoffSeconds: v })}
            min={0}
          />
          <NumberField
            label={fieldLabel("retry.baseDelaySec")}
            description={fieldDescription("retry.baseDelaySec")}
            value={retry?.baseDelaySec}
            onChange={(v) => onUpdateRetry({ baseDelaySec: v })}
            min={0}
          />
        </div>

        {/* Comment template with improved description */}
        {onUpdateCloseout && (
          <div>
            <label className={labelCls}>{fieldLabel("closeout.commentTemplate")}</label>
            <p className="mb-2 text-[10px] text-muted-fg/35">
              {"Template for the comment ADE posts on the Linear issue. Supports {{issue.title}}, {{run.status}}, {{pr.url}} placeholders."}
            </p>
            <textarea
              className={cn(textareaCls, "min-h-[60px]")}
              value={closeout?.commentTemplate ?? ""}
              onChange={(e) => onUpdateCloseout({ commentTemplate: e.target.value || null })}
              placeholder={"{{issue.title}} completed by ADE"}
            />
          </div>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <Toggle
            label={fieldLabel("observability.emitNotifications")}
            checked={observability?.emitNotifications ?? false}
            onChange={(v) => onUpdateObservability({ emitNotifications: v })}
          />
          <Toggle
            label={fieldLabel("observability.captureIssueSnapshot")}
            checked={observability?.captureIssueSnapshot ?? false}
            onChange={(v) => onUpdateObservability({ captureIssueSnapshot: v })}
          />
          <Toggle
            label={fieldLabel("observability.persistTimeline")}
            checked={observability?.persistTimeline ?? false}
            onChange={(v) => onUpdateObservability({ persistTimeline: v })}
          />
        </div>
      </Section>
    </div>
  );
}
