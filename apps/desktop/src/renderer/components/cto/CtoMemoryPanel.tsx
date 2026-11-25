import React, { useCallback, useEffect, useState } from "react";
import {
  CTO_PROJECT_NOTES_MAX_BYTES,
  CTO_USER_NOTES_MAX_BYTES,
  type OpenProjectBinding,
} from "../../../shared/types";
import { ModernSection } from "../settings/primitives";
import { Banner } from "../ui/notice";
import { CtoArchiveList } from "./CtoArchiveList";
import { CtoOpenWorkList } from "./CtoOpenWorkList";
import { AutosaveTextArea, CTO_SETTINGS_GROUP } from "./ctoSettingsUi";
import { useCtoMemory } from "./useCtoMemory";

/**
 * Settings › Memory: what the CTO keeps between conversations, all of it
 * editable. The project notes (`.ade/cto/MEMORY.md`), the notes about the
 * person (shared by every project on the CTO's machine) and the open-work
 * list. The CTO is given all three on every turn. Below them, the archive:
 * what left the notes, facts from past turns, discoveries and story versions.
 */
export function CtoMemoryPanel({
  pin,
  sessionId,
}: {
  pin: OpenProjectBinding | null;
  /** The CTO chat: its finished turns are what change the notes. */
  sessionId: string | null;
}) {
  const { memory, loading, error, refresh, updateNotes, updateOpenWork, recallArchived } = useCtoMemory(pin);
  // Story folds add facts after a turn without touching the notes: re-read the archive too.
  const [archiveTick, setArchiveTick] = useState(0);

  // The CTO writes notes while you are elsewhere; read them fresh on return.
  useEffect(() => {
    const onFocus = () => {
      void refresh();
      setArchiveTick((tick) => tick + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // ...and while this page is open: re-read when a CTO turn ends on its home
  // machine. The editors adopt the new text, or say it changed under them.
  useEffect(() => {
    if (!pin || !sessionId) return undefined;
    return window.ade.agentChat.onEvent((envelope) => {
      if (envelope.sessionId !== sessionId || envelope.event.type !== "done") return;
      void refresh();
      setArchiveTick((tick) => tick + 1);
    }, pin);
    // Keyed on the pin's key: a rebuilt pin for the same machine re-subscribes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key, refresh, sessionId]);

  const saveProject = useCallback(
    (text: string, baseHash?: string) => updateNotes({ scope: "project", text, ...(baseHash ? { baseHash } : {}) }),
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

      <ModernSection
        group={CTO_SETTINGS_GROUP}
        anchor="cto.memory.archive"
        title="Archive"
        hint="What left the notes, facts from past turns, and every story version"
      >
        <CtoArchiveList
          pin={pin}
          refreshKey={`${memory.memoryHash ?? ""}|${memory.userNotesHash ?? ""}|${archiveTick}`}
          onRecall={recallArchived}
        />
      </ModernSection>
    </div>
  );
}
