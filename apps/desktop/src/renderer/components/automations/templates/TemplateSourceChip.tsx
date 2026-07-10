import type { ElementType } from "react";
import { accentTint, eventLabel, sourceAccent, sourceDef, sourceForTriggerType, type TriggerSource } from "../triggerCatalog";

/** Accent-tinted icon badge for a template's trigger source. */
export function SourceIconBadge({
  source,
  size,
  icon: Icon,
}: {
  source: TriggerSource;
  /** Outer box size in px; the glyph scales at half. */
  size: number;
  icon: ElementType;
}) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg border"
      style={{
        width: size,
        height: size,
        borderColor: accentTint(source, 0.25),
        background: accentTint(source, 0.12),
        color: sourceAccent(source),
      }}
    >
      <Icon size={Math.round(size / 2)} weight="regular" />
    </span>
  );
}

/** "Source · Event" chip with the source's brand icon, e.g. "GitHub · Issue opened". */
export function TemplateSourceChip({ triggerType, className }: { triggerType: string; className?: string }) {
  const source = sourceForTriggerType(triggerType);
  const definition = sourceDef(source);
  const SourceIcon = definition.icon;
  return (
    <span
      className={className ?? "inline-flex min-w-0 items-center gap-1 truncate text-[10.5px]"}
      style={{ color: accentTint(source, 0.85) }}
      title={triggerType}
    >
      <SourceIcon size={11} weight="fill" className="shrink-0" />
      <span className="truncate">{definition.label} · {eventLabel(triggerType)}</span>
    </span>
  );
}
