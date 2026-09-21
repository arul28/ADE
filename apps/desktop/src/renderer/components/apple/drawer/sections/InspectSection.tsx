import { DRAWER_BUTTON, Row, Section, SwitchRow } from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";
import {
  commandFor,
  describeElement,
  inspectContextFor,
  POS_IDENTITY_HINT,
  refTierMeaning,
  type IosSimulatorSnapshotElement,
} from "../../appleInspectGeometry";

/**
 * §8.3 — the overlay switch, and the selected frame's details in the row grid.
 *
 * The overlay itself (frames drawn over the stream) and the selection are the
 * pane's; this section only shows the switch and what was picked. The
 * "Insert into chat" verb is offered only when the host gave us a composer.
 */
export function InspectSection({
  ctx,
  enabled,
  setEnabled,
  selected,
  onInsertDraft,
}: {
  ctx: AppleDrawerContext;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  selected: IosSimulatorSnapshotElement | null;
  onInsertDraft?: ((text: string) => void) | undefined;
}) {
  const described = selected ? describeElement(selected) : null;
  const frame = selected?.frame;
  const frameText = frame ? `${frame.x},${frame.y} ${frame.width}×${frame.height}` : "—";
  const command = selected ? commandFor(selected) : null;
  const context = selected ? inspectContextFor(selected, [selected]) : null;
  return (
    <Section title="Inspect" testId="apple-drawer-inspect">
      <SwitchRow
        label="Overlay element frames"
        checked={enabled}
        disabled={!ctx.visible}
        onChange={setEnabled}
      />
      {selected && described ? (
        <div className="flex flex-col" data-testid="apple-drawer-inspect-details">
          <Row label="Label"><span className="truncate text-xs text-fg/85">{selected.label ?? "—"}</span></Row>
          <Row label="Role"><span className="truncate text-xs text-fg/85">{selected.role ?? selected.elementType ?? "—"}</span></Row>
          <Row label="Identifier"><span className="truncate font-mono text-xs text-fg/85">{selected.identifier ?? "—"}</span></Row>
          <Row label="Ref"><span className="truncate text-xs text-fg/85">{described.refTier} {refTierMeaning(described.refTier)}</span></Row>
          <Row label="Frame"><span className="truncate font-mono text-xs text-fg/85">{frameText}</span></Row>
          <Row label="Source"><span className="truncate text-xs text-fg/85">{described.source}</span></Row>
          {described.refTier === "pos:" ? (
            <p className="pt-1 text-[11px] text-amber-100/80">{POS_IDENTITY_HINT}</p>
          ) : null}
          <div className="flex min-h-7 items-center gap-1.5">
            <button
              type="button"
              className={DRAWER_BUTTON}
              disabled={!command}
              onClick={() => { if (command) void window.ade.app.writeClipboardText(command).catch(() => {}); }}
            >
              Copy command
            </button>
            <button
              type="button"
              className={DRAWER_BUTTON}
              disabled={!context || !onInsertDraft}
              onClick={() => { if (context && onInsertDraft) onInsertDraft(context); }}
            >
              Insert into chat
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-fg/70">
          {enabled ? "Click a frame on the device." : "Turn the overlay on, then click a frame."}
        </p>
      )}
    </Section>
  );
}
