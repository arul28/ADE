import React from "react";
import { Box, Text, type DOMElement } from "ink";
import { theme } from "../../theme";
import { useHoveredHitId } from "../../hitTestRegistry";
import type { ModelWizardOption, ModelWizardView } from "../../modelWizard";
import { measurePaneOrigin } from "./ModelPickerPane";
import { wizardRowWindow } from "./modelWizardGeometry";

/**
 * Renders one step of the /model wizard: a title, the breadcrumb of already
 * chosen steps, and a single vertical list of options. Every row is exactly one
 * line so modelWizardGeometry can derive click rects from the same windowing
 * this render uses.
 */

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function optionGlyph(option: ModelWizardOption): string {
  switch (option.kind) {
    case "recent": return "↺";
    case "provider": return "◈";
    case "family": return "▹";
    case "model": return "○";
    case "done": return "✓";
    default: return "·";
  }
}

function WizardRow({
  option,
  focused,
  hovered,
  width,
}: {
  option: ModelWizardOption;
  focused: boolean;
  hovered: boolean;
  width: number;
}) {
  const disabled = option.disabled === true;
  // Hover reads exactly like keyboard focus (violet) so the mouse and the arrow
  // keys describe the same row — the convention ModelPickerPane already uses.
  const accent = focused || hovered ? theme.color.violet : theme.color.t2;
  const trailing = option.kind === "setting"
    ? option.value ?? ""
    : option.hint ?? "";
  const trailingRoom = trailing ? Math.min(18, trailing.length) : 0;
  const labelRoom = Math.max(6, width - trailingRoom - 4);
  return (
    <Text wrap="truncate-end">
      <Text color={focused ? theme.color.violet : theme.color.t4}>{focused ? "▸ " : "  "}</Text>
      <Text color={disabled ? theme.color.t4 : accent} dimColor={disabled}>
        {`${optionGlyph(option)} `}
      </Text>
      <Text color={disabled ? theme.color.t4 : accent} bold={focused} dimColor={disabled}>
        {endTruncate(option.label, labelRoom)}
      </Text>
      {trailing ? (
        <Text color={theme.color.t4} dimColor>{`  ${endTruncate(trailing, trailingRoom)}`}</Text>
      ) : null}
    </Text>
  );
}

export function ModelWizardPane({
  view,
  width,
  onMeasureOrigin,
}: {
  view: ModelWizardView;
  width: number;
  /** Reports the measured content origin (1-based cells) for click hit-testing. */
  onMeasureOrigin?: (origin: { x: number; y: number; width: number }) => void;
}) {
  const hoveredId = useHoveredHitId();
  const rootRef = React.useRef<DOMElement | null>(null);
  React.useEffect(() => {
    if (!onMeasureOrigin) return;
    const node = rootRef.current;
    if (!node) return;
    const origin = measurePaneOrigin(node);
    // Yoga is 0-based; mouse/hit-test coords are 1-based.
    if (origin) onMeasureOrigin({ x: origin.x + 1, y: origin.y + 1, width: origin.width });
  }, [onMeasureOrigin, width, view.step]);

  const innerWidth = Math.max(20, width - 4);
  const window = wizardRowWindow(view);
  const visible = view.options.slice(window.start, window.end);
  const focusedOption = view.options[view.index] ?? null;

  return (
    <Box flexDirection="column" ref={rootRef}>
      <Text color={theme.color.t1} bold wrap="truncate-end">
        {endTruncate(view.title, innerWidth)}
      </Text>
      {view.breadcrumb.length ? (
        <Text color={theme.color.t4} dimColor wrap="truncate-end">
          {endTruncate(view.breadcrumb.join(" › "), innerWidth)}
        </Text>
      ) : null}
      <Box marginBottom={1} />
      {visible.length ? (
        visible.map((option, sliceIndex) => {
          const index = window.start + sliceIndex;
          return (
            <WizardRow
              key={option.id}
              option={option}
              focused={index === view.index}
              hovered={hoveredId === `right:model-wizard:option:${option.id}`}
              width={innerWidth}
            />
          );
        })
      ) : (
        <Text color={theme.color.t4} dimColor>Nothing available here yet.</Text>
      )}
      {view.options.length > window.end ? (
        <Text color={theme.color.t4} dimColor>{`↓ ${view.options.length - window.end} more`}</Text>
      ) : null}
      {focusedOption?.detail ? (
        <Box marginTop={1}>
          <Text color={theme.color.t4} dimColor wrap="truncate-end">
            {endTruncate(focusedOption.detail, innerWidth)}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor wrap="truncate-end">{endTruncate(view.hint, innerWidth)}</Text>
      </Box>
    </Box>
  );
}
