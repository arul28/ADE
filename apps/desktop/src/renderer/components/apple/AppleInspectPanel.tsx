import { useMemo } from "react";
import { ArrowClockwise, CaretDown, CaretRight, ChatText, Copy } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  WORK_TOOL_CHROME_CHIP,
  WORK_TOOL_CHROME_CHIP_WRAP,
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_SECTION_LABEL_TEXT,
} from "../terminals/workToolChrome";
import {
  ancestorsOf,
  commandFor,
  describeElement,
  findElement,
  inspectContextFor,
  inspectTree,
  POS_IDENTITY_HINT,
  refTierMeaning,
  type AppleInspectTreeNode,
  type IosSimulatorSnapshotElement,
} from "./appleInspectGeometry";

export type AppleInspectPanelProps = {
  elements: IosSimulatorSnapshotElement[];
  selectedRef: string | null;
  onSelect: (ref: string | null) => void;
  onCopyCommand: (command: string) => void;
  onInsertIntoChat: (context: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
};

const ROW = "flex items-start gap-1.5 px-0.5 py-[3px]";
const ROW_LABEL = "w-[5.5rem] shrink-0 font-sans text-[11px] text-muted-fg/70";
const ROW_VALUE = "min-w-0 flex-1 break-words font-sans text-[11px] text-fg/82";

function flattenVisible(
  nodes: AppleInspectTreeNode[],
  expanded: ReadonlySet<string>,
): AppleInspectTreeNode[] {
  const rows: AppleInspectTreeNode[] = [];
  for (const node of nodes) {
    rows.push(node);
    if (expanded.has(node.element.id) && node.children.length > 0) {
      rows.push(...flattenVisible(node.children, expanded));
    }
  }
  return rows;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROW}>
      <div className={ROW_LABEL}>{label}</div>
      <div className={ROW_VALUE}>{value}</div>
    </div>
  );
}

export function AppleInspectPanel({
  elements,
  selectedRef,
  onSelect,
  onCopyCommand,
  onInsertIntoChat,
  refreshing,
  onRefresh,
}: AppleInspectPanelProps) {
  const selected = findElement(elements, selectedRef);
  const tree = useMemo(() => inspectTree(elements), [elements]);
  const expanded = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedRef) return ids;
    ids.add(selectedRef);
    for (const ancestor of ancestorsOf(elements, selectedRef)) ids.add(ancestor.id);
    return ids;
  }, [elements, selectedRef]);
  const rows = useMemo(() => flattenVisible(tree, expanded), [expanded, tree]);
  const described = selected ? describeElement(selected) : null;
  const command = selected ? commandFor(selected) : null;
  const context = selected ? inspectContextFor(selected, elements) : null;
  const frame = selected?.frame;
  const frameText = frame
    ? `${frame.x},${frame.y} ${frame.width}×${frame.height}`
    : "—";

  return (
    <div className="flex h-full min-h-0 w-72 flex-col" data-testid="apple-inspect-panel">
      <div className={WORK_TOOL_CHROME_ROW}>
        <div className={cn("min-w-0 flex-1 truncate", WORK_TOOL_SECTION_LABEL_TEXT)}>Inspect</div>
        <PaneTooltip label="Refresh accessibility snapshot" className={WORK_TOOL_CHROME_CHIP_WRAP}>
          <button
            type="button"
            className={WORK_TOOL_CHROME_CHIP}
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            data-testid="apple-inspect-refresh"
          >
            <ArrowClockwise size={12} className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </button>
        </PaneTooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <div className={cn("px-0.5 pb-1", WORK_TOOL_SECTION_LABEL_TEXT)}>Tree</div>
        <div role="tree" data-testid="apple-inspect-tree">
          {rows.map((node) => {
            const isSelected = node.element.id === selectedRef;
            const hasChildren = node.children.length > 0;
            const isOpen = hasChildren && expanded.has(node.element.id);
            const label = describeElement(node.element).title;
            return (
              <button
                key={node.element.id}
                type="button"
                role="treeitem"
                aria-selected={isSelected}
                aria-expanded={hasChildren ? isOpen : undefined}
                className={cn(
                  "flex w-full items-center gap-1 rounded-[7px] px-1 py-[3px] text-left font-sans text-[11px]",
                  isSelected ? "bg-cyan-500/22 text-cyan-100/95" : "text-fg/80 hover:bg-white/[0.06]",
                )}
                style={{ paddingLeft: 4 + node.depth * 12 }}
                onClick={() => onSelect(node.element.id)}
              >
                <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted-fg/70">
                  {hasChildren
                    ? (isOpen ? <CaretDown size={10} /> : <CaretRight size={10} />)
                    : <span className="h-[3px] w-[3px] rounded-full bg-muted-fg/40" />}
                </span>
                <span className="min-w-0 truncate">{label}</span>
              </button>
            );
          })}
        </div>

        <div className={cn("px-0.5 pb-1 pt-3", WORK_TOOL_SECTION_LABEL_TEXT)}>Details</div>
        {described && selected ? (
          <div data-testid="apple-inspect-details">
            <DetailRow label="Label" value={selected.label ?? "—"} />
            <DetailRow label="Role" value={selected.role ?? selected.elementType ?? "—"} />
            <DetailRow label="Identifier" value={selected.identifier ?? "—"} />
            <DetailRow
              label="Ref"
              value={`${described.refTier} ${refTierMeaning(described.refTier)}`}
            />
            <DetailRow label="Frame" value={frameText} />
            <DetailRow label="Source" value={described.source} />
            {described.refTier === "pos:" ? (
              <p className="px-0.5 pt-1 font-sans text-[11px] text-amber-100/80">
                {POS_IDENTITY_HINT}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="px-0.5 font-sans text-[11px] text-muted-fg/60">Select an element on the device.</p>
        )}
      </div>

      <div className={cn(WORK_TOOL_CHROME_ROW, "gap-1")}>
        <PaneTooltip label="Copy as ade command" className={WORK_TOOL_CHROME_CHIP_WRAP}>
          <button
            type="button"
            className={WORK_TOOL_CHROME_CHIP}
            disabled={!command}
            aria-label="Copy command"
            data-testid="apple-inspect-copy"
            onClick={() => { if (command) onCopyCommand(command); }}
          >
            <Copy size={12} />
            Copy command
          </button>
        </PaneTooltip>
        <PaneTooltip label="Insert inspect context into chat" className={WORK_TOOL_CHROME_CHIP_WRAP}>
          <button
            type="button"
            className={WORK_TOOL_CHROME_CHIP}
            disabled={!context}
            aria-label="Insert into chat"
            data-testid="apple-inspect-insert"
            onClick={() => { if (context) onInsertIntoChat(context); }}
          >
            <ChatText size={12} />
            Insert into chat
          </button>
        </PaneTooltip>
      </div>
    </div>
  );
}
