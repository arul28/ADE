import React, { useCallback, useState, type KeyboardEvent } from "react";
import type { LinearWorkflowTrigger } from "../../../../../shared/types/linearSync";
import { labelCls } from "../../shared/designTokens";
import { fieldDescription, fieldLabel } from "../pipelineLabels";

type Props = {
  triggers: LinearWorkflowTrigger;
  onUpdate: (field: keyof LinearWorkflowTrigger, values: unknown) => void;
};

/* ── Chip input ── */

function ChipInput({
  items,
  onAdd,
  onRemove,
  placeholder,
  color,
}: {
  items: string[];
  onAdd: (v: string) => void;
  onRemove: (index: number) => void;
  placeholder: string;
  color: string;
}) {
  const [draft, setDraft] = useState("");

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && draft.trim()) {
        e.preventDefault();
        onAdd(draft.trim());
        setDraft("");
      }
      if (e.key === "Backspace" && !draft && items.length) {
        onRemove(items.length - 1);
      }
    },
    [draft, items, onAdd, onRemove],
  );

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(21,26,35,0.92),rgba(14,18,26,0.94))] px-3 py-2 transition-all duration-200 focus-within:border-[rgba(56,189,248,0.45)]"
    >
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ color, background: `${color}14`, border: `1px solid ${color}20` }}
        >
          {item}
          <button
            type="button"
            onClick={() => onRemove(i)}
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

/* ── Expandable section ── */

function Section({ title, tier, children }: { title: string; tier: string; children: React.ReactNode }) {
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

/* ── Simple string-list helpers ── */

function addItem(list: string[] | undefined, value: string): string[] {
  const arr = list ?? [];
  return arr.includes(value) ? arr : [...arr, value];
}
function removeItem(list: string[] | undefined, index: number): string[] {
  const arr = [...(list ?? [])];
  arr.splice(index, 1);
  return arr;
}

/* ── Main component ── */

export function TriggerConfig({ triggers, onUpdate }: Props) {
  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-fg/70">Trigger Conditions</div>

      {/* Essential: Assignees */}
      <div>
        <label className={labelCls}>{fieldLabel("triggers.assignees")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.assignees")}</p>
        <ChipInput
          items={triggers.assignees ?? []}
          onAdd={(v) => onUpdate("assignees", addItem(triggers.assignees, v))}
          onRemove={(i) => onUpdate("assignees", removeItem(triggers.assignees, i))}
          placeholder="Type an assignee name, press Enter"
          color="#38BDF8"
        />
      </div>

      {/* Essential: Labels */}
      <div>
        <label className={labelCls}>{fieldLabel("triggers.labels")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.labels")}</p>
        <ChipInput
          items={triggers.labels ?? []}
          onAdd={(v) => onUpdate("labels", addItem(triggers.labels, v))}
          onRemove={(i) => onUpdate("labels", removeItem(triggers.labels, i))}
          placeholder="Type a label, press Enter"
          color="#34D399"
        />
      </div>

      {/* Advanced */}
      <Section title="Advanced" tier="advanced">
        <div>
          <label className={labelCls}>{fieldLabel("triggers.projectSlugs")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.projectSlugs")}</p>
          <ChipInput
            items={triggers.projectSlugs ?? []}
            onAdd={(v) => onUpdate("projectSlugs", addItem(triggers.projectSlugs, v))}
            onRemove={(i) => onUpdate("projectSlugs", removeItem(triggers.projectSlugs, i))}
            placeholder="Project slug"
            color="#A78BFA"
          />
        </div>
        <div>
          <label className={labelCls}>{fieldLabel("triggers.teamKeys")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.teamKeys")}</p>
          <ChipInput
            items={triggers.teamKeys ?? []}
            onAdd={(v) => onUpdate("teamKeys", addItem(triggers.teamKeys, v))}
            onRemove={(i) => onUpdate("teamKeys", removeItem(triggers.teamKeys, i))}
            placeholder="Team key"
            color="#FBBF24"
          />
        </div>
        <div>
          <label className={labelCls}>{fieldLabel("triggers.priority")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.priority")}</p>
          <ChipInput
            items={triggers.priority ?? []}
            onAdd={(v) => onUpdate("priority", addItem(triggers.priority, v))}
            onRemove={(i) => onUpdate("priority", removeItem(triggers.priority, i))}
            placeholder="urgent, high, normal, low, none"
            color="#FB7185"
          />
        </div>
      </Section>

      {/* Expert */}
      <Section title="Expert" tier="expert">
        <div>
          <label className={labelCls}>{fieldLabel("triggers.owner")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.owner")}</p>
          <ChipInput
            items={triggers.owner ?? []}
            onAdd={(v) => onUpdate("owner", addItem(triggers.owner, v))}
            onRemove={(i) => onUpdate("owner", removeItem(triggers.owner, i))}
            placeholder="Issue owner"
            color="#F472B6"
          />
        </div>
        <div>
          <label className={labelCls}>{fieldLabel("triggers.creator")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.creator")}</p>
          <ChipInput
            items={triggers.creator ?? []}
            onAdd={(v) => onUpdate("creator", addItem(triggers.creator, v))}
            onRemove={(i) => onUpdate("creator", removeItem(triggers.creator, i))}
            placeholder="Issue creator"
            color="#C084FC"
          />
        </div>
        <div>
          <label className={labelCls}>{fieldLabel("triggers.metadataTags")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("triggers.metadataTags")}</p>
          <ChipInput
            items={triggers.metadataTags ?? []}
            onAdd={(v) => onUpdate("metadataTags", addItem(triggers.metadataTags, v))}
            onRemove={(i) => onUpdate("metadataTags", removeItem(triggers.metadataTags, i))}
            placeholder="tag:value"
            color="#94A3B8"
          />
        </div>
      </Section>
    </div>
  );
}
