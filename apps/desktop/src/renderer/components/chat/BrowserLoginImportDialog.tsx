import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Browser,
  Browsers,
  CheckCircle,
  Compass,
  Gear,
  GoogleChromeLogo,
  MagnifyingGlass,
  SignIn,
  SpinnerGap,
  WarningCircle,
  X,
  type Icon,
} from "@phosphor-icons/react";
import type {
  BrowserLoginImportDomain,
  BrowserLoginImportResult,
  BrowserLoginImportSource,
} from "../../../shared/types/builtInBrowserLoginImport";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { isMacRuntimeTarget } from "../../lib/platform";
import { STANDARD_EASE } from "../../lib/motion";
import { cn } from "../ui/cn";

/**
 * Import the logins you already have.
 *
 * Three steps on one surface — pick a browser profile, pick the sites, read
 * what landed — because the whole flow is one decision ("let ADE reuse my
 * session for these sites") and splitting it across screens would make it feel
 * like a migration rather than a choice.
 *
 * Human-only by construction: every call here goes through
 * `ade.builtInBrowser.loginImport.*`, which has no pin overload and is absent
 * from the agent bridge. Nothing in this file is reachable from a tool call.
 */

type LoginImportApi = {
  listSources: () => Promise<{ sources: BrowserLoginImportSource[] }>;
  listDomains: (args: { sourceId: string }) => Promise<unknown>;
  import: (args: { sourceId: string; domains: string[] }) => Promise<BrowserLoginImportResult>;
};

type Step = "sources" | "domains" | "done";

const REVEAL = { duration: 0.18, ease: STANDARD_EASE };

/** The three steps, named the way the dialog talks about them. */
const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: "sources", label: "Browser" },
  { id: "domains", label: "Sites" },
  { id: "done", label: "Done" },
];

/**
 * A recognisable mark per browser.
 *
 * An "S" in a circle could be Safari, Sigma or Slack. Phosphor has Chrome's
 * mark and Safari's compass; the rest fall back to a browser window, which at
 * least says "this is a browser" rather than "this is a letter".
 */
function browserGlyph(source: BrowserLoginImportSource): Icon {
  const id = `${source.browserId} ${source.browserName}`.toLowerCase();
  if (id.includes("chrome") || id.includes("chromium")) return GoogleChromeLogo;
  if (id.includes("safari")) return Compass;
  if (source.engine === "firefox" || id.includes("firefox") || id.includes("zen")) return Browsers;
  return Browser;
}

function loginImportApi(): LoginImportApi | null {
  const api = (window.ade as unknown as {
    builtInBrowser?: { loginImport?: LoginImportApi };
  })?.builtInBrowser?.loginImport;
  return api && typeof api.listSources === "function" ? api : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceReason(source: BrowserLoginImportSource): string {
  if (source.status === "ready") return "";
  return source.reason ?? "This browser cannot be imported from right now.";
}

export function BrowserLoginImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after a successful import so the panel can refresh its diagnostics. */
  onImported?: (result: Extract<BrowserLoginImportResult, { ok: true }>) => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [step, setStep] = useState<Step>("sources");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<BrowserLoginImportSource[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [domains, setDomains] = useState<BrowserLoginImportDomain[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<Extract<BrowserLoginImportResult, { ok: true }> | null>(null);

  const reset = useCallback(() => {
    setStep("sources");
    setBusy(false);
    setError(null);
    setSourceId(null);
    setDomains([]);
    setSelected(new Set());
    setSearch("");
    setResult(null);
  }, []);

  const loadSources = useCallback(async () => {
    const api = loginImportApi();
    if (!api) {
      setError("This ADE build does not expose browser login import.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const listed = await api.listSources();
      setSources(listed.sources ?? []);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    reset();
    void loadSources();
  }, [loadSources, open, reset]);

  const pickSource = useCallback(async (source: BrowserLoginImportSource) => {
    const api = loginImportApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    setSourceId(source.id);
    try {
      const listed = (await api.listDomains({ sourceId: source.id })) as
        | { ok: true; domains: BrowserLoginImportDomain[]; unreadableCount: number }
        | { ok: false; reason: string };
      if (!listed || listed.ok !== true) {
        setError(listed && "reason" in listed ? listed.reason : "Could not read that browser's cookies.");
        setSourceId(null);
        return;
      }
      setDomains(listed.domains);
      setSelected(new Set());
      setSearch("");
      setStep("domains");
    } catch (caught) {
      setError(errorText(caught));
      setSourceId(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const runImport = useCallback(async () => {
    const api = loginImportApi();
    if (!api || !sourceId || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await api.import({ sourceId, domains: [...selected] });
      if (!imported || imported.ok !== true) {
        setError(imported && "reason" in imported ? imported.reason : "The import did not complete.");
        return;
      }
      setResult(imported);
      setStep("done");
      onImported?.(imported);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, [onImported, selected, sourceId]);

  /*
    System Settings opens through a purpose-built main-side IPC, never through
    `openExternal`. The pane address is an `x-apple.systempreferences:` URL, and
    the external-link allowlist accepts only http(s) and mailto — so the one
    remediation button on the Full Disk Access path used to reject every single
    time. Main owns the URL; the renderer only names which pane it wants.
  */
  const openSettingsPane = useCallback((paneId: SystemSettingsPaneId) => {
    const failed = () => {
      setError("Could not open System Settings. Open Privacy & Security › Full Disk Access yourself.");
    };
    const open = window.ade.app.openSystemSettingsPane;
    if (typeof open !== "function") {
      failed();
      return;
    }
    void open(paneId)
      .then((result) => {
        if (!result?.opened) failed();
      })
      .catch(failed);
  }, []);

  const visibleDomains = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return domains;
    return domains.filter((entry) => entry.domain.toLowerCase().includes(query));
  }, [domains, search]);

  const allVisibleSelected = visibleDomains.length > 0
    && visibleDomains.every((entry) => selected.has(entry.domain));

  const toggleDomain = useCallback((domain: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setSelected((previous) => {
      const next = new Set(previous);
      const everySelected = visibleDomains.every((entry) => next.has(entry.domain));
      for (const entry of visibleDomains) {
        if (everySelected) next.delete(entry.domain);
        else next.add(entry.domain);
      }
      return next;
    });
  }, [visibleDomains]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            {/* The dim-and-blur every other ADE modal uses, so this one reads
                as the same kind of interruption rather than a stray panel. */}
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-2xl"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <motion.div
                className={cn(
                  "fixed left-1/2 top-[12%] z-[130] flex max-h-[76vh] w-[560px] max-w-[94vw] -translate-x-1/2",
                  "flex-col overflow-hidden rounded-[var(--radius-xl)]",
                  "font-sans text-[12px] text-fg/80 focus:outline-none",
                )}
                style={{
                  background:
                    "radial-gradient(120% 120% at 0% 0%, rgba(167,139,250,0.10), transparent 55%), "
                    + "radial-gradient(100% 100% at 100% 100%, rgba(82,56,175,0.10), transparent 60%), "
                    + "var(--color-popup-bg, var(--color-card))",
                  border: "1px solid transparent",
                  backgroundClip: "padding-box",
                  boxShadow:
                    "0 36px 100px -28px rgba(0,0,0,0.88), 0 0 0 1px rgba(167,139,250,0.22), "
                    + "0 18px 48px -24px rgba(167,139,250,0.28)",
                }}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.97, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
                transition={{ duration: 0.2, ease: [0.34, 1.56, 0.64, 1] }}
              >
                <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3.5 py-2.5">
                  <SignIn size={15} weight="duotone" className="shrink-0 text-[var(--color-accent)]" />
                  <Dialog.Title className="min-w-0 truncate text-[12.5px] font-medium text-fg">
                    Import logins
                  </Dialog.Title>
                  <StepIndicator step={step} />
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-muted-fg/70 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    >
                      <X size={13} />
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="px-3.5 pt-2.5 text-[11px] leading-[16px] text-muted-fg">
                  {step === "sources"
                    ? "Copy cookies from a browser you are already signed in to, so ADE's browser opens those sites signed in too. Passwords are never read."
                    : step === "domains"
                      ? "Pick the sites worth carrying over. Everything else stays where it is."
                      : "Here is what landed in ADE's browser profile."}
                </Dialog.Description>

                <AnimatePresence initial={false}>
                  {error ? (
                    <motion.div
                      key="login-import-error"
                      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={REVEAL}
                      className="overflow-hidden px-3.5"
                    >
                      <div
                        role="alert"
                        className="mt-2.5 flex items-start gap-2 rounded-[var(--radius-md)] border border-rose-400/20 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-100/85"
                      >
                        <WarningCircle size={13} className="mt-px shrink-0" />
                        <span className="min-w-0 break-words">{error}</span>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
                  {step === "sources" ? (
                    <SourceList
                      sources={sources}
                      busy={busy}
                      pendingSourceId={sourceId}
                      onPick={(source) => void pickSource(source)}
                      onOpenSettings={openSettingsPane}
                    />
                  ) : null}

                  {step === "domains" ? (
                    <DomainPicker
                      domains={visibleDomains}
                      totalCount={domains.length}
                      search={search}
                      onSearch={setSearch}
                      selected={selected}
                      allVisibleSelected={allVisibleSelected}
                      onToggle={toggleDomain}
                      onToggleAll={toggleAllVisible}
                    />
                  ) : null}

                  {step === "done" && result ? <ImportSummary result={result} /> : null}
                </div>

                <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.07] px-3.5 py-2.5">
                  {step === "domains" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setStep("sources");
                          setSourceId(null);
                        }}
                        className="ade-shell-control inline-flex h-7 items-center px-2.5 text-[11px] font-medium"
                        data-variant="ghost"
                      >
                        Back
                      </button>
                      <span className="ml-auto text-[10.5px] text-muted-fg">
                        {selected.size === 0
                          ? "No sites selected"
                          : `${selected.size} ${selected.size === 1 ? "site" : "sites"} selected`}
                      </span>
                      <button
                        type="button"
                        disabled={busy || selected.size === 0}
                        onClick={() => void runImport()}
                        className="ade-shell-control inline-flex h-7 items-center gap-1.5 px-3 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {busy ? <SpinnerGap size={12} className="animate-spin" /> : null}
                        Import
                      </button>
                    </>
                  ) : null}
                  {step === "sources" ? (
                    <>
                      {/* Ghost, not bare text: it is a real control, and a
                          borderless label read as a caption in QA. */}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void loadSources()}
                        className="ade-shell-control inline-flex h-7 items-center gap-1.5 px-2.5 text-[11px] font-medium disabled:opacity-45"
                        data-variant="ghost"
                      >
                        {busy ? <SpinnerGap size={11} className="animate-spin" /> : null}
                        Check again
                      </button>
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className="ade-shell-control ml-auto inline-flex h-7 items-center px-3 text-[11px] font-medium"
                        >
                          Cancel
                        </button>
                      </Dialog.Close>
                    </>
                  ) : null}
                  {step === "done" ? (
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="ade-shell-control ml-auto inline-flex h-7 items-center px-3 text-[11px] font-medium"
                      >
                        Done
                      </button>
                    </Dialog.Close>
                  ) : null}
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/**
 * Where you are in the three steps.
 *
 * The dialog does the whole import on one surface, which is right — but that
 * left no answer to "how much more of this is there?". Three dots answer it
 * without adding a screen.
 */
function StepIndicator({ step }: { step: Step }) {
  const activeIndex = STEPS.findIndex((entry) => entry.id === step);
  return (
    <div
      className="ml-auto flex shrink-0 select-none items-center gap-1.5"
      role="group"
      aria-label={`Step ${activeIndex + 1} of ${STEPS.length}: ${STEPS[activeIndex]?.label ?? ""}`}
    >
      {STEPS.map((entry, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <span key={entry.id} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn("h-px w-3", done || active ? "bg-[var(--color-accent)]/40" : "bg-white/[0.10]")}
              />
            ) : null}
            <span
              className={cn(
                "text-[9.5px] font-medium uppercase tracking-[0.08em] transition-colors duration-[120ms] ease-out",
                active ? "text-fg/85" : done ? "text-[var(--color-accent)]/70" : "text-muted-fg/45",
              )}
            >
              {entry.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function SourceList({
  sources,
  busy,
  pendingSourceId,
  onPick,
  onOpenSettings,
}: {
  sources: BrowserLoginImportSource[];
  busy: boolean;
  pendingSourceId: string | null;
  onPick: (source: BrowserLoginImportSource) => void;
  onOpenSettings: (paneId: SystemSettingsPaneId) => void;
}) {
  if (busy && sources.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-[11px] text-muted-fg">
        <SpinnerGap size={13} className="animate-spin" />
        {`Looking for browsers on this ${isMacRuntimeTarget() ? "Mac" : "computer"}…`}
      </div>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="py-6 text-[11px] leading-[17px] text-muted-fg">
        No browser profiles turned up on this machine. If you use a browser ADE did not find, open it
        once and check again.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Browsers you can import from">
      {sources.map((source) => {
        const ready = source.status === "ready";
        const reason = sourceReason(source);
        const Glyph = browserGlyph(source);
        const settingsPaneId = source.settingsPaneId;
        return (
          <li key={source.id}>
            <div
              className={cn(
                "flex items-center gap-2.5 rounded-[var(--radius-lg)] border border-white/[0.07] bg-card/55 px-2.5 py-2",
                "transition-colors duration-[120ms] ease-out",
                ready ? "hover:border-white/[0.14]" : "opacity-70",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.05]",
                  ready ? "text-fg/80" : "text-muted-fg/60",
                )}
              >
                <Glyph size={15} weight="duotone" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-[12px] font-medium text-fg">{source.browserName}</span>
                  <span className="truncate text-[10.5px] text-muted-fg">{source.profileName}</span>
                </span>
                {ready ? null : (
                  <span className="mt-0.5 block text-[10.5px] leading-[15px] text-amber-100/75">{reason}</span>
                )}
              </span>
              {ready ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(source)}
                  className="ade-shell-control inline-flex h-6 shrink-0 items-center gap-1.5 px-2.5 text-[10.5px] font-medium disabled:opacity-45"
                >
                  {busy && pendingSourceId === source.id ? (
                    <SpinnerGap size={11} className="animate-spin" />
                  ) : null}
                  Choose
                </button>
              ) : settingsPaneId ? (
                <button
                  type="button"
                  onClick={() => onOpenSettings(settingsPaneId)}
                  className="ade-shell-control inline-flex h-6 shrink-0 items-center gap-1.5 px-2.5 text-[10.5px] font-medium"
                >
                  <Gear size={11} />
                  Open System Settings
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DomainPicker({
  domains,
  totalCount,
  search,
  onSearch,
  selected,
  allVisibleSelected,
  onToggle,
  onToggleAll,
}: {
  domains: BrowserLoginImportDomain[];
  totalCount: number;
  search: string;
  onSearch: (value: string) => void;
  selected: Set<string>;
  allVisibleSelected: boolean;
  onToggle: (domain: string) => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-md)] border border-white/[0.08] bg-black/25 px-2 focus-within:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]">
          <MagnifyingGlass size={12} className="shrink-0 text-muted-fg/60" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search sites"
            aria-label="Search sites"
            className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-fg/85 outline-none placeholder:text-muted-fg/45"
          />
        </label>
        <button
          type="button"
          onClick={onToggleAll}
          disabled={domains.length === 0}
          className="ade-shell-control inline-flex h-7 shrink-0 items-center px-2.5 text-[10.5px] font-medium disabled:opacity-45"
          data-variant="ghost"
        >
          {allVisibleSelected ? "Clear all" : "Select all"}
        </button>
      </div>
      {domains.length === 0 ? (
        <div className="py-5 text-[11px] text-muted-fg">
          {totalCount === 0
            ? "That profile has no cookies ADE can import."
            : "No sites match that search."}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-white/[0.05] overflow-hidden rounded-[var(--radius-lg)] border border-white/[0.07]">
          {domains.map((entry) => {
            const checked = selected.has(entry.domain);
            return (
              <li key={entry.domain}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5",
                    "transition-colors duration-[120ms] ease-out hover:bg-white/[0.035]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(entry.domain)}
                    className="h-3 w-3 shrink-0 accent-[var(--color-accent)]"
                    aria-label={entry.domain}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg/85">{entry.domain}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-fg">
                    {entry.cookieCount} {entry.cookieCount === 1 ? "cookie" : "cookies"}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ImportSummary({
  result,
}: {
  result: Extract<BrowserLoginImportResult, { ok: true }>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px] font-medium text-emerald-100/90">
        <CheckCircle size={14} weight="duotone" />
        {`Imported ${result.importedCount} ${result.importedCount === 1 ? "cookie" : "cookies"}`}
        {result.skippedCount > 0 ? (
          <span className="text-[10.5px] font-normal text-muted-fg">{`· ${result.skippedCount} skipped`}</span>
        ) : null}
      </div>
      {result.domains.length > 0 ? (
        <ul className="flex flex-col divide-y divide-white/[0.05] overflow-hidden rounded-[var(--radius-lg)] border border-white/[0.07]">
          {result.domains.map((entry) => (
            <li
              key={entry.domain}
              className="flex items-center gap-2.5 px-2.5 py-1.5 text-[11px]"
            >
              <span className="min-w-0 flex-1 truncate text-fg/85">{entry.domain}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-fg">
                {`${entry.imported} in`}
                {entry.skipped > 0 ? ` · ${entry.skipped} skipped` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[10.5px] leading-[15px] text-muted-fg">
        Open one of these sites in ADE's browser to check you are signed in. Nothing was changed in the
        browser you imported from.
      </p>
    </div>
  );
}
