import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CaretDown, CaretRight, Plus, Trash } from "@phosphor-icons/react";
import {
  CTO_SKILL_MAX_BYTES,
  CTO_SKILLS_MAX,
  ctoSkillSlug,
  isCtoNotesChangedError,
  type CtoSkillFile,
  type CtoSkillSummary,
  type OpenProjectBinding,
} from "../../../shared/types";
import { ipcErrorMessage } from "../../lib/format";
import { cn } from "../ui/cn";
import { AutosaveTextArea, CtoEmptyLine } from "./ctoSettingsUi";

const ROW = "flex min-w-0 items-center gap-2.5 rounded-md px-2";

function newSkillText(name: string): string {
  return `---\nname: ${name}\ndescription: When to use this skill, in one line\n---\n\n1. First step\n2. Check that it worked\n`;
}

/**
 * The CTO's skills, one how-to per kind of task. Each row opens its whole
 * SKILL.md in an autosaving editor; the CTO reads them only when a task
 * calls for one. All reads and writes go to the CTO's home machine (`pin`).
 */
export function CtoSkillsList({
  pin,
  skills,
  onChanged,
}: {
  pin: OpenProjectBinding;
  skills: CtoSkillSummary[];
  /** After a write: the panel re-reads the snapshot. */
  onChanged: () => Promise<void>;
}) {
  const [openName, setOpenName] = useState<string | null>(null);
  const [file, setFile] = useState<CtoSkillFile | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const full = skills.length >= CTO_SKILLS_MAX;

  // Read through a ref so a rebuilt pin for the same machine reloads nothing.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin.key;

  const load = useCallback(async (name: string) => {
    try {
      setFile(await window.ade.cto!.getSkill({ name }, pinRef.current));
      setError(null);
    } catch (err) {
      setError(ipcErrorMessage(err) || "Couldn't read the skill.");
    }
  }, []);

  useEffect(() => {
    if (openName) void load(openName);
    else setFile(null);
  }, [openName, pinKey, load]);

  const save = useCallback(async (name: string, text: string, baseHash?: string) => {
    try {
      await window.ade.cto!.writeSkill({ name, text, ...(baseHash ? { baseHash } : {}) }, pinRef.current);
    } catch (err) {
      // Changed elsewhere: read the newer file, so the editor's Reload takes it.
      if (isCtoNotesChangedError(err)) await load(name);
      throw err;
    }
    await load(name);
    await onChanged();
  }, [load, onChanged]);

  const remove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await window.ade.cto!.deleteSkill({ name }, pin);
      if (openName === name) setOpenName(null);
      await onChanged();
    } catch (err) {
      setError(ipcErrorMessage(err) || "Couldn't delete the skill.");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const name = ctoSkillSlug(draftName ?? "");
    if (!name) {
      setDraftName(null);
      return;
    }
    // A name that already exists opens that skill; a template never replaces it.
    if (skills.some((skill) => skill.name === name)) {
      setDraftName(null);
      setOpenName(name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.ade.cto!.writeSkill({ name, text: newSkillText(name) }, pin);
      setDraftName(null);
      await onChanged();
      setOpenName(name);
    } catch (err) {
      setError(ipcErrorMessage(err) || "Couldn't add the skill.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {skills.length === 0 && draftName == null ? (
        <CtoEmptyLine icon={<BookOpen size={14} />}>No skills yet. The CTO saves one after a kind of task it will do again.</CtoEmptyLine>
      ) : null}
      {skills.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {skills.map((skill) => {
            const isOpen = openName === skill.name;
            return (
              <li key={skill.name} className="flex min-w-0 flex-col">
                <div className={cn(ROW, "group py-1.5 transition-colors hover:bg-[var(--kit-hover)]")}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpenName(isOpen ? null : skill.name)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line,currentColor)]"
                  >
                    <span className="flex w-4 shrink-0 justify-center text-[var(--kit-text-3)]" aria-hidden>
                      {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
                    </span>
                    <span className="shrink-0 text-[12.5px] font-medium text-fg">{skill.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--kit-text-3)]" title={skill.description}>
                      {skill.description}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete skill "${skill.name}"`}
                    disabled={busy}
                    onClick={() => void remove(skill.name)}
                    className="kit-icon-btn shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    style={{ width: 18, height: 18 }}
                  >
                    <Trash size={11} />
                  </button>
                </div>
                {isOpen && file?.name === skill.name ? (
                  <div className="px-2 pb-2 pl-[34px]">
                    <AutosaveTextArea
                      ariaLabel={`Skill ${skill.name}`}
                      value={file.text}
                      hash={file.hash}
                      limit={CTO_SKILL_MAX_BYTES}
                      rows={12}
                      onSave={(text, baseHash) => save(skill.name, text, baseHash)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {draftName != null ? (
        <div className={cn(ROW, "py-0.5")}>
          <BookOpen size={16} className="shrink-0 text-[var(--kit-text-3)]" aria-hidden />
          <input
            autoFocus
            className="kit-input min-w-0 flex-1"
            data-size="sm"
            value={draftName}
            placeholder="Skill name, e.g. release-desktop"
            aria-label="New skill name"
            disabled={busy}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              } else if (event.key === "Escape") {
                setDraftName(null);
              }
            }}
            onBlur={() => { if (!draftName.trim()) setDraftName(null); }}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={full}
          title={full ? `Full: ${CTO_SKILLS_MAX} skills` : undefined}
          onClick={() => { setError(null); setDraftName(""); }}
          className={cn(
            ROW,
            "h-7 self-start pr-2.5 text-[12px] text-[var(--kit-text-2)] outline-none transition-colors hover:bg-[var(--kit-hover)] hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--cto-accent-line,currentColor)] disabled:opacity-50",
          )}
        >
          <span className="flex w-4 shrink-0 justify-center" aria-hidden><Plus size={12} weight="bold" /></span>
          Add
        </button>
      )}
      {error ? <CtoEmptyLine tone="crit" hint={error}>{error}</CtoEmptyLine> : null}
    </div>
  );
}
