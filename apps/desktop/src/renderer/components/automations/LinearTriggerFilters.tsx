import type { AutomationTrigger } from "../../../shared/types";
import { INPUT_CLS, INPUT_STYLE } from "./shared";

export function LinearTriggerFilters({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const isStateTransition = trigger.type === "linear.issue_status_changed";
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
      ) : (
        <LabeledInput
          label="Labels"
          value={(trigger.labels ?? []).join(", ")}
          placeholder="bug, priority"
          onChange={(value) =>
            onPatch({
              labels: value
                .split(",")
                .map((l) => l.trim())
                .filter(Boolean),
            })
          }
        />
      )}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
