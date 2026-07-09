import type { AutomationTrigger } from "../../../shared/types";
import { INPUT_CLS, INPUT_STYLE, parseList } from "./shared";

export function LinearTriggerFilters({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const isStateTransition = trigger.type === "linear.issue_status_changed";
  const isLabeled = trigger.type === "linear.issue_labeled";
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <LabeledInput
        label="Team"
        value={trigger.team ?? ""}
        placeholder="ENG"
        onChange={(value) => onPatch({ team: value })}
      />
      <LabeledInput
        label="Project"
        value={trigger.project ?? ""}
        placeholder="Core platform"
        onChange={(value) => onPatch({ project: value })}
      />
      <LabeledInput
        label="Assignee"
        value={trigger.assignee ?? ""}
        placeholder="username or email"
        onChange={(value) => onPatch({ assignee: value })}
      />
      {isStateTransition ? (
        <LabeledInput
          label="State transition"
          value={trigger.stateTransition ?? ""}
          placeholder="In Progress->Done"
          onChange={(value) => onPatch({ stateTransition: value })}
        />
      ) : isLabeled ? (
        <LabeledInput
          label="Label added"
          value={(trigger.labels ?? []).join(", ")}
          placeholder="agent, ready-to-build"
          hint="Fires only when one of these labels is added. Leave blank to match any label."
          onChange={(value) => onPatch({ labels: parseList(value) })}
        />
      ) : (
        <LabeledInput
          label="Labels"
          value={(trigger.labels ?? []).join(", ")}
          placeholder="bug, priority"
          onChange={(value) =>
            onPatch({
              labels: parseList(value),
            })
          }
        />
      )}
      <LabeledInput
        label="Changed fields"
        value={(trigger.changedFields ?? []).join(", ")}
        placeholder="title, description, labels"
        onChange={(value) => onPatch({ changedFields: parseList(value) })}
      />
      <LabeledInput
        label="Keywords"
        value={(trigger.keywords ?? []).join(", ")}
        placeholder="escalated, customer"
        onChange={(value) => onPatch({ keywords: parseList(value) })}
      />
    </div>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-muted-fg/70">{label}</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {hint ? <span className="block text-[10px] leading-snug text-muted-fg/55">{hint}</span> : null}
    </label>
  );
}
