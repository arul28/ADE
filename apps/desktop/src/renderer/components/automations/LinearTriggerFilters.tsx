import type { AutomationTrigger } from "../../../shared/types";
import { useNavigate } from "react-router-dom";
import { INPUT_CLS, INPUT_STYLE, parseList } from "./shared";
import { settingsRouteFor } from "../settings/settingsManifest";

export function LinearTriggerFilters({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const navigate = useNavigate();
  const isStateTransition = trigger.type === "linear.issue_status_changed";
  const isLabeled = trigger.type === "linear.issue_labeled";
  if (trigger.type === "linear.agent_delegated" || trigger.type === "linear.agent_mentioned") {
    return (
      <div className="space-y-2">
        <p className="text-[11px] leading-relaxed text-muted-fg/70">
          Linear sends each delegation or @ADE mention to the ADE of the person who asked. Teammates’ requests run on their
          own ADE. Requests from people who do not use ADE come here only if “Run it on my ADE” is chosen in{" "}
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-fg"
            onClick={() => navigate(settingsRouteFor("integrations.linear"))}
          >
            Settings → Linear → ADE agent
          </button>
          .
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <LabeledInput label="Team" value={trigger.team ?? ""} placeholder="ENG" onChange={(value) => onPatch({ team: value })} />
          <LabeledInput label="Project" value={trigger.project ?? ""} placeholder="Core platform" onChange={(value) => onPatch({ project: value })} />
          <LabeledInput
            label="Issue labels"
            value={(trigger.labels ?? []).join(", ")}
            placeholder="bug, agent"
            onChange={(value) => onPatch({ labels: parseList(value) })}
          />
        </div>
      </div>
    );
  }
  if (trigger.type === "linear.user_joined") {
    return <p className="text-[11px] text-muted-fg/60">Runs once for each new member. No filters.</p>;
  }
  if (trigger.type === "linear.project_update_posted" || trigger.type === "linear.initiative_update_posted") {
    return (
      <div className="grid gap-2 md:grid-cols-2">
        {trigger.type === "linear.project_update_posted" ? (
          <LabeledInput label="Project" value={trigger.project ?? ""} placeholder="Core platform" onChange={(value) => onPatch({ project: value })} />
        ) : null}
        <LabeledInput
          label="Keywords"
          value={(trigger.keywords ?? []).join(", ")}
          placeholder="at risk, blocked"
          hint="Matches the update text and its health (onTrack, atRisk, offTrack)."
          onChange={(value) => onPatch({ keywords: parseList(value) })}
        />
      </div>
    );
  }
  if (trigger.type === "linear.comment_created") {
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <LabeledInput label="Team" value={trigger.team ?? ""} placeholder="ENG" onChange={(value) => onPatch({ team: value })} />
        <LabeledInput label="Project" value={trigger.project ?? ""} placeholder="Core platform" onChange={(value) => onPatch({ project: value })} />
        <LabeledInput
          label="Issue labels"
          value={(trigger.labels ?? []).join(", ")}
          placeholder="bug, customer"
          onChange={(value) => onPatch({ labels: parseList(value) })}
        />
        <LabeledInput
          label="Commenters"
          value={(trigger.authors ?? []).join(", ")}
          placeholder="name as shown in Linear"
          onChange={(value) => onPatch({ authors: parseList(value) })}
        />
        <LabeledInput
          label="Keywords"
          value={(trigger.keywords ?? []).join(", ")}
          placeholder="repro, urgent, @ade"
          hint="Fires when the comment contains one of these."
          onChange={(value) => onPatch({ keywords: parseList(value) })}
        />
      </div>
    );
  }
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
