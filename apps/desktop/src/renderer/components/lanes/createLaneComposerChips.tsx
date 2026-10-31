import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretUpDown, Check, Desktop, DesktopTower, Plus, Scales, Stack } from "@phosphor-icons/react";
import { usePortalContainer } from "../ui/portalContainer";
import { Z_LAYERS } from "../ui/zLayers";
import { formatBytes } from "../../lib/format";
import type { LaneTemplate } from "../../../shared/types";
import type { CreateLaneMode } from "./CreateLaneDialog";
import {
  autoLaneMachine,
  canAutoPlaceOnMachine,
  canCreateLaneOnMachine,
  isLowLaneMachineDisk,
  laneMachineFreeBytes,
  THIS_MACHINE_ID,
  type LaneMachineOption,
} from "./laneMachines";
import { autoPickSummary, machineLoadSummary, placementTag } from "./machineLoadText";

/**
 * The popovers of the new-lane composer: the shared popover shell and row, and
 * the machine and template chips. The dialog owns which chip is open.
 */

type ComposerPopoverState = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog's mode, so the portaled popover keeps the mode colour. */
  mode: CreateLaneMode;
};

/** One popover look for every chip in the composer. */
export function ComposerPopover({
  open,
  onOpenChange,
  mode,
  trigger,
  children,
  fit,
}: ComposerPopoverState & {
  trigger: React.ReactNode;
  children: React.ReactNode;
  /** "content" sizes the popover to its content instead of the trigger's width. */
  fit?: "content";
}) {
  // Inside the dialog, portal into it: a modal dialog blocks pointer events
  // and focus everywhere outside its own content.
  const portalContainer = usePortalContainer();
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={10}
          // Stay below the field; long lists shrink to the room there instead
          // of flipping above the dialog and off the window.
          avoidCollisions={false}
          className="cl-pop"
          data-fit={fit}
          data-mode={mode}
          style={{ zIndex: Z_LAYERS.dialogPopover }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // React events bubble through the portal: keep a popover's Enter from
          // reaching the composer's ⌘/Ctrl+Enter create shortcut.
          onKeyDown={(event) => {
            if (event.key === "Enter") event.stopPropagation();
          }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PopItem({
  icon,
  title,
  sub,
  subTone,
  selected,
  disabled,
  muted,
  hint,
  onSelect,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  subTone?: "warn";
  selected?: boolean;
  disabled?: boolean;
  muted?: boolean;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="cl-item"
      // Action rows ("Connect another machine…") pass no `selected`: not a toggle.
      aria-pressed={selected}
      disabled={disabled}
      title={hint}
      data-muted={muted ? "true" : undefined}
      onClick={onSelect}
    >
      {icon}
      <span className="cl-item-text">
        <span className="cl-item-title">{title}</span>
        {sub ? <span className="cl-item-sub" data-tone={subTone}>{sub}</span> : null}
      </span>
      {selected ? <Check size={13} weight="bold" className="cl-item-check" /> : null}
    </button>
  );
}

function machineDetail(machine: LaneMachineOption): { text: string; short: string; path: string | null; warn: boolean } {
  const path = machine.project?.rootPath ?? machine.hostname ?? null;
  if (!canCreateLaneOnMachine(machine)) return { text: "This repo isn't here yet", short: "No repo", path, warn: false };
  const freeBytes = laneMachineFreeBytes(machine);
  const free = freeBytes !== null ? `${formatBytes(freeBytes)} disk free` : null;
  const load = machineLoadSummary(machine.stats);
  return {
    text: [placementTag(machine), load, free].filter(Boolean).join(" · ") || path || "Connected",
    short: free ?? "Connected",
    path,
    warn: isLowLaneMachineDisk(freeBytes),
  };
}

function MachineIcon({ machineId }: { machineId: string }) {
  return machineId === THIS_MACHINE_ID
    ? <Desktop size={13} weight="duotone" />
    : <DesktopTower size={13} weight="duotone" />;
}

/** The machine this lane (and its chats) will live on. */
export function LaneMachineChip({
  popover,
  machines,
  selectedMachineId,
  onSelectMachine,
  onConnectMachine,
  disabled,
}: {
  popover: ComposerPopoverState;
  machines: LaneMachineOption[];
  selectedMachineId: string;
  onSelectMachine: (machineId: string) => void;
  onConnectMachine?: () => void;
  disabled: boolean;
}) {
  const close = () => popover.onOpenChange(false);
  // Only machines automatic placement may choose: a Manual only one is not balanced across.
  const eligibleCount = machines.filter(canAutoPlaceOnMachine).length;
  const autoMachine = autoLaneMachine(machines);
  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId) ?? null;
  return (
    <ComposerPopover
      {...popover}
      trigger={(
        <button
          type="button"
          className="cl-field"
          disabled={disabled}
          data-tone={selectedMachine ? undefined : "warn"}
          data-empty={selectedMachine ? undefined : "true"}
          data-tour="lanes.createDialog.machine"
          data-testid={selectedMachine ? undefined : "lane-machine-selector-required"}
          aria-label="Machine for this lane"
        >
          <span className="cl-tile" data-tone={selectedMachine ? "machine" : "warn"}>
            <MachineIcon machineId={selectedMachine?.id ?? THIS_MACHINE_ID} />
          </span>
          <span className="cl-field-text">{selectedMachine?.name ?? "Choose a machine…"}</span>
          {selectedMachine ? <span className="cl-field-meta">{machineDetail(selectedMachine).short}</span> : null}
          <CaretUpDown size={12} className="cl-field-caret" />
        </button>
      )}
    >
      <div role="group" aria-label="Machine for this lane">
        {autoMachine ? (
          <>
            <PopItem
              icon={<span className="cl-tile" data-tone="machine"><Scales size={13} weight="duotone" /></span>}
              title="Least loaded"
              sub={autoPickSummary(autoMachine)}
              hint={`Balance across ${eligibleCount} connected machines`}
              onSelect={() => {
                onSelectMachine(autoMachine.id);
                close();
              }}
            />
            <div className="cl-pop-rule" />
          </>
        ) : null}
        {machines.map((machine) => {
          const detail = machineDetail(machine);
          const available = canCreateLaneOnMachine(machine);
          return (
            <PopItem
              key={machine.id}
              icon={<span className="cl-tile" data-tone="muted"><MachineIcon machineId={machine.id} /></span>}
              title={machine.name}
              sub={detail.text}
              subTone={detail.warn ? "warn" : undefined}
              selected={machine.id === selectedMachineId}
              disabled={!available}
              hint={available ? detail.path ?? undefined : `${machine.name} doesn't have this repo yet.`}
              onSelect={() => {
                onSelectMachine(machine.id);
                close();
              }}
            />
          );
        })}
        {onConnectMachine ? (
          <>
            <div className="cl-pop-rule" />
            <PopItem
              icon={<span className="cl-tile" data-tone="muted"><Plus size={12} weight="bold" /></span>}
              title="Connect another machine…"
              muted
              onSelect={() => {
                close();
                onConnectMachine();
              }}
            />
          </>
        ) : null}
      </div>
    </ComposerPopover>
  );
}

/** The lane template: env files, installs and services set up in the new lane. */
export function LaneTemplateChip({
  popover,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onManageTemplates,
  disabled,
}: {
  popover: ComposerPopoverState;
  templates: LaneTemplate[];
  selectedTemplateId: string;
  onSelectTemplate: (templateId: string) => void;
  onManageTemplates?: () => void;
  disabled: boolean;
}) {
  const close = () => popover.onOpenChange(false);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;
  return (
    <ComposerPopover
      {...popover}
      trigger={(
        <button
          type="button"
          className="cl-extra"
          data-set={selectedTemplate ? "true" : undefined}
          disabled={disabled}
          aria-label="Template"
          title={selectedTemplate?.description ?? "Set up env files, installs and services in the new lane"}
        >
          <span className="cl-tile" data-tone={selectedTemplate ? "machine" : "muted"}><Stack size={13} weight="duotone" /></span>
          <span className="cl-extra-text">
            <span className="cl-extra-title">{selectedTemplate ? selectedTemplate.name : "Use a template"}</span>
            {selectedTemplate ? <span className="cl-extra-sub">Template</span> : null}
          </span>
          {selectedTemplate ? <CaretUpDown size={12} className="cl-field-caret" /> : null}
        </button>
      )}
    >
      <div role="group" aria-label="Template">
        {templates.length > 0 ? (
          <>
            <PopItem
              title="No template"
              muted
              selected={!selectedTemplateId}
              onSelect={() => {
                onSelectTemplate("");
                close();
              }}
            />
            {templates.map((template) => (
              <PopItem
                key={template.id}
                icon={<span className="cl-tile" data-tone="muted"><Stack size={12} weight="duotone" /></span>}
                title={template.name}
                sub={template.description}
                selected={template.id === selectedTemplateId}
                onSelect={() => {
                  onSelectTemplate(template.id);
                  close();
                }}
              />
            ))}
          </>
        ) : (
          <div className="cl-pop-empty">No templates yet. A template sets up env files, installs and services in every new lane.</div>
        )}
        {onManageTemplates ? (
          <>
            <div className="cl-pop-rule" />
            <PopItem
              icon={<span className="cl-tile" data-tone="muted"><Plus size={12} weight="bold" /></span>}
              title={templates.length > 0 ? "Manage templates…" : "Create a template…"}
              muted
              onSelect={() => {
                close();
                onManageTemplates();
              }}
            />
          </>
        ) : null}
      </div>
    </ComposerPopover>
  );
}
