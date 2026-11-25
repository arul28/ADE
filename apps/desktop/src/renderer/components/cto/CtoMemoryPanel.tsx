import React, { useCallback, useEffect } from "react";
import {
  CTO_PROJECT_NOTES_MAX_BYTES,
  CTO_RULES_MAX_BYTES,
  CTO_USER_NOTES_MAX_BYTES,
  type OpenProjectBinding,
} from "../../../shared/types";
import { ModernSection } from "../settings/primitives";
import { Banner } from "../ui/notice";
import { CtoOpenWorkList } from "./CtoOpenWorkList";
import { CtoSkillsList } from "./CtoSkillsList";
import { AutosaveTextArea, CTO_SETTINGS_GROUP } from "./ctoSettingsUi";
import { useCtoMemory } from "./useCtoMemory";

/**
 * Settings › Memory: what the CTO keeps between conversations, all of it
 * editable. Its rules (`.ade/cto/RULES.md`, yours and its own), its skills
 * (one how-to per kind of task), the project notes (`.ade/cto/MEMORY.md`),
 * the notes about the person (shared by every project on the CTO's machine)
 * and the open-work list. Everything but the skills' bodies rides every turn.
 */
export function CtoMemoryPanel({
  pin,
  sessionId,
}: {
  pin: OpenProjectBinding | null;
  /** The CTO chat: its finished turns are what change the notes. */
  sessionId: string | null;
}) {
  const { memory, loading, error, refresh, updateNotes, updateOpenWork } = useCtoMemory(pin);

  // The CTO writes notes while you are elsewhere; read them fresh on return.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // ...and while this page is open: re-read when a CTO turn ends on its home
  // machine. The editors adopt the new text, or say it changed under them.
  useEffect(() => {
    if (!pin || !sessionId) return undefined;
    return window.ade.agentChat.onEvent((envelope) => {
      if (envelope.sessionId === sessionId && envelope.event.type === "done") void refresh();
    }, pin);
    // Keyed on the pin's key: a rebuilt pin for the same machine re-subscribes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key, refresh, sessionId]);

  const saveProject = useCallback(
    (text: string, baseHash?: string) => updateNotes({ scope: "project", text, ...(baseHash ? { baseHash } : {}) }),
    [updateNotes],
  );
  const saveRules = useCallback(
    (text: string, baseHash?: string) => updateNotes({ scope: "rules", text, ...(baseHash ? { baseHash } : {}) }),
    [updateNotes],
  );
  const saveUser = useCallback(
    (text: string, baseHash?: string) => updateNotes({ scope: "user", text, ...(baseHash ? { baseHash } : {}) }),
    [updateNotes],
  );

  if (!memory) {
    if (error) {
      return (
        <Banner
          layout="inline"
          model={{
            id: "cto-memory-error",
            tone: "error",
            title: "Couldn't read notes",
            detail: error,
            actions: [{ label: "Try again", onClick: () => void refresh() }],
          }}
        />
      );
    }
    return <p className="ade-modern-muted">{loading ? "Loading…" : "Home machine unreachable"}</p>;
  }

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.memory.rules"
        title="Rules"
        hint="Yours and the CTO's, followed every turn"
      >
        <AutosaveTextArea
          ariaLabel="Rules"
          value={memory.rules ?? ""}
          hash={memory.rulesHash}
          limit={memory.rulesLimitBytes ?? CTO_RULES_MAX_BYTES}
          rows={8}
          placeholder={"- Ask before landing a PR — merges to main deploy at once.\n- Use opus for reviews — it catches more than the default."}
          onSave={saveRules}
        />
      </ModernSection>

      {pin ? (
        <ModernSection
          group={CTO_SETTINGS_GROUP}
          anchor="cto.memory.skills"
          title="Skills"
          hint="One how-to per kind of task"
        >
          <div className="ade-modern-rows" style={{ padding: 8 }}>
            <CtoSkillsList pin={pin} skills={memory.skills ?? []} onChanged={refresh} />
          </div>
        </ModernSection>
      ) : null}

      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.memory.project"
        title="Project notes"
        hint="One note per line"
      >
        <AutosaveTextArea
          ariaLabel="Project notes"
          value={memory.memory}
          hash={memory.memoryHash}
          limit={memory.memoryLimitBytes ?? CTO_PROJECT_NOTES_MAX_BYTES}
          rows={10}
          placeholder={"- Deploys go through the release lane\n- Tests run with npm run test:unit"}
          onSave={saveProject}
        />
      </ModernSection>

      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.memory.user"
        title="About you"
        hint="Shared by every project here"
      >
        <AutosaveTextArea
          ariaLabel="About you"
          value={memory.userNotes ?? ""}
          hash={memory.userNotesHash}
          limit={memory.userNotesLimitBytes ?? CTO_USER_NOTES_MAX_BYTES}
          rows={6}
          placeholder={"- Prefers short answers\n- Reviews PRs in the morning"}
          onSave={saveUser}
        />
      </ModernSection>

      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.memory.openWork"
        title="Open work"
      >
        <div className="ade-modern-rows" style={{ padding: 8 }}>
          <CtoOpenWorkList items={memory.openWork ?? []} onChange={updateOpenWork} />
        </div>
      </ModernSection>
    </div>
  );
}
