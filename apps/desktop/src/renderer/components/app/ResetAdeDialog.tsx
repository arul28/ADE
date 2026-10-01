import { CaretRight, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MachineResetItemKind,
  MachineResetPlan,
  MachineResetRescueMode,
} from "../../../shared/types/machineReset";
import { Dialog } from "../ui/dialog";
import { ERROR_GHOST_BUTTON } from "./errorSurfaceKit";

/** Typed by the person to arm the reset. One word, in capitals, so it is never typed by accident. */
const CONFIRM_WORD = "RESET";

/** What each kind of item means to the person, in their words, not ADE's. */
const KIND_SUMMARY: Record<MachineResetItemKind, string> = {
  process: "Everything ADE is running right now, including its terminals and agents.",
  background_service: "The part of ADE that runs in the background.",
  directory: "ADE's settings, caches and logs on this computer.",
  file: "ADE's settings, caches and logs on this computer.",
  keychain: "Your ADE sign-in and the keys you saved in ADE. Sign in again afterwards.",
  config_entry: "Small changes ADE made to other apps, such as a line in your shell settings.",
};

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review"; plan: MachineResetPlan }
  | { kind: "starting" }
  | { kind: "started" };

const RESCUE_CHOICES: ReadonlyArray<{ mode: MachineResetRescueMode; title: string; detail: string }> = [
  {
    mode: "commit",
    title: "Keep the work on its branch",
    detail: "ADE commits each lane's unsaved changes to the lane's own branch. The branches stay in your repositories; the lane folders are removed.",
  },
  {
    mode: "move",
    title: "Move the lane folders out",
    detail: "ADE moves each lane folder, with git, into a folder you pick. Git still knows about them.",
  },
  {
    mode: "none",
    title: "Delete it too",
    detail: "Lanes are removed with everything else, and their uncommitted changes are gone. A branch with commits that exist nowhere else is kept.",
  },
];

/**
 * The hard reset, last resort of every recovery path: removes everything ADE
 * put on this computer — every project's ADE data and lanes included — and
 * reopens ADE as a first install. The plan comes from the reset engine itself,
 * so what this dialog lists is exactly what the engine will remove.
 */
export function ResetAdeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [rescue, setRescue] = useState<MachineResetRescueMode>("commit");
  const [rescueDir, setRescueDir] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [showItems, setShowItems] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStage({ kind: "loading" });
    setTyped("");
    setShowItems(false);
    const bridge = window.ade?.machineReset;
    if (!bridge) {
      setStage({ kind: "error", message: "This version of ADE can't reset itself from here. Run `ade reset --all` in a terminal instead." });
      return;
    }
    bridge
      .plan()
      .then((plan) => {
        if (cancelled) return;
        setRescue(plan.lanesWithWork > 0 ? "commit" : "none");
        setStage({ kind: "review", plan });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const chooseRescueDir = useCallback(async () => {
    const picked = await window.ade?.machineReset?.chooseRescueDir().catch(() => null);
    if (picked) setRescueDir(picked);
  }, []);

  const plan = stage.kind === "review" ? stage.plan : null;
  const lanesWithWork = useMemo(
    () => plan?.projects.flatMap((project) =>
      project.lanes
        .filter((lane) => lane.uncommittedFiles > 0 || lane.unpushedCommits > 0)
        .map((lane) => ({ project: project.displayName, lane })),
    ) ?? [],
    [plan],
  );
  // One plain line per kind of thing, in a fixed order; folders and files
  // read the same to a person, so they share a line.
  const summaryLines = useMemo(() => {
    const kinds = new Set(plan?.items.map((item) => item.kind) ?? []);
    const order: MachineResetItemKind[] = ["directory", "keychain", "background_service", "process", "config_entry"];
    return order
      .filter((kind) => kinds.has(kind) || (kind === "directory" && kinds.has("file")))
      .map((kind) => KIND_SUMMARY[kind]);
  }, [plan]);

  const armed = typed.trim() === CONFIRM_WORD && (rescue !== "move" || Boolean(rescueDir));

  const start = useCallback(async () => {
    if (!armed) return;
    setStage({ kind: "starting" });
    try {
      const result = await window.ade.machineReset!.start({ rescue, rescueDir: rescue === "move" ? rescueDir : null });
      if (!result.started) {
        setStage({ kind: "error", message: result.error ?? "ADE could not start the reset." });
        return;
      }
      setStage({ kind: "started" });
    } catch (error) {
      setStage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [armed, rescue, rescueDir]);

  const busy = stage.kind === "starting" || stage.kind === "started";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Reset ADE completely"
      description="Removes everything ADE put on this computer, then starts ADE fresh."
      tone="error"
      icon={<Trash size={16} weight="bold" />}
      size="md"
      maxHeight="88vh"
      role="alertdialog"
      dismissible={!busy}
      hideClose={busy}
      actions={
        stage.kind === "review"
          ? [
            { label: "Cancel", variant: "secondary", onClick: () => onOpenChange(false) },
            { label: "Reset and reopen ADE", variant: "solid", disabled: !armed, onClick: () => void start() },
          ]
          : stage.kind === "error"
            ? [{ label: "Close", variant: "secondary", onClick: () => onOpenChange(false) }]
            : []
      }
    >
      {stage.kind === "loading" ? (
        <p className="text-[12.5px] text-fg/60">Looking at what ADE put on this computer…</p>
      ) : null}

      {stage.kind === "error" ? (
        <p className="text-[12.5px] leading-relaxed text-fg/70">{stage.message}</p>
      ) : null}

      {busy ? (
        <p className="text-[12.5px] leading-relaxed text-fg/70">
          ADE is closing to finish the reset. It reopens by itself as a new install in a moment.
        </p>
      ) : null}

      {plan ? (
        <div className="flex flex-col gap-4 text-[12.5px] leading-relaxed text-fg/70">
          <div>
            <p className="font-medium text-fg/85">What the reset removes</p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 marker:text-fg/25">
              {plan.projects.length ? (
                <li>
                  ADE&apos;s data and lanes in {plan.projects.length === 1 ? "1 project" : `${plan.projects.length} projects`}:{" "}
                  {plan.projects.slice(0, 6).map((p) => p.displayName).join(", ")}
                  {plan.projects.length > 6 ? ` and ${plan.projects.length - 6} more` : ""}.
                  {" "}Your code and your repositories stay.
                </li>
              ) : null}
              {summaryLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setShowItems((value) => !value)}
              className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-fg/55 hover:text-fg/80"
            >
              <CaretRight size={11} weight="bold" className={showItems ? "rotate-90 transition-transform" : "transition-transform"} />
              {showItems ? "Hide every item" : "Show every item"}
            </button>
            {showItems ? (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border/60 bg-fg/[0.02] px-3 py-2 font-mono text-[11px] text-fg/60">
                {plan.items.map((item) => (
                  <li key={`${item.kind}:${item.target}`} className="truncate" title={item.target}>
                    {item.target}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {lanesWithWork.length ? (
            <div>
              <p className="font-medium text-fg/85">
                {lanesWithWork.length === 1 ? "1 lane has work" : `${lanesWithWork.length} lanes have work`} that isn&apos;t saved anywhere else
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-[12px] text-fg/55">
                {lanesWithWork.slice(0, 8).map(({ project, lane }) => (
                  <li key={lane.path}>
                    {project} / {lane.name}
                    {lane.uncommittedFiles ? ` — ${lane.uncommittedFiles} changed files` : ""}
                    {lane.unpushedCommits ? ` — ${lane.unpushedCommits} unpushed commits` : ""}
                  </li>
                ))}
                {lanesWithWork.length > 8 ? <li>…and {lanesWithWork.length - 8} more</li> : null}
              </ul>
              <div className="mt-2 flex flex-col gap-1.5" role="radiogroup" aria-label="What to do with lane work">
                {RESCUE_CHOICES.map((choice) => (
                  <div key={choice.mode} className="rounded-lg border border-border/60 hover:bg-fg/[0.03]">
                    <label className="flex cursor-pointer items-start gap-2 px-3 py-2">
                      <input
                        type="radio"
                        name="ade-reset-rescue"
                        className="mt-1"
                        checked={rescue === choice.mode}
                        onChange={() => setRescue(choice.mode)}
                      />
                      <span>
                        <span className="block font-medium text-fg/85">{choice.title}</span>
                        <span className="block text-[12px] text-fg/55">{choice.detail}</span>
                      </span>
                    </label>
                    {/* Outside the label: a button inside one hands its clicks to the radio. */}
                    {choice.mode === "move" && rescue === "move" ? (
                      <button
                        type="button"
                        onClick={() => void chooseRescueDir()}
                        className="mb-2 ml-8 text-left text-[12px] font-medium text-fg/80 underline decoration-fg/30 underline-offset-2"
                      >
                        {rescueDir ? `Folder: ${rescueDir} (change)` : "Choose a folder…"}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {plan.notes.length ? (
            <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] text-fg/50 marker:text-fg/25">
              {plan.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-fg/85">Type {CONFIRM_WORD} to confirm</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="rounded-lg border border-border/70 bg-bg/60 px-3 py-1.5 font-mono text-[12.5px] text-fg outline-none focus:border-red-400/50"
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
            />
          </label>
        </div>
      ) : null}
    </Dialog>
  );
}

/** The quiet entry point recovery surfaces put beside "Report issue". */
export function ResetAdeButton({ label = "Reset ADE…", className = ERROR_GHOST_BUTTON }: { label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>
      {open ? <ResetAdeDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
