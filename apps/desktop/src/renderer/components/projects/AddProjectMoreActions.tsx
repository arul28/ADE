import { FolderOpen, FolderPlus } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, fgTint } from "../lanes/laneDesignTokens";

export type AddProjectPlace = { key: string; name: string };

// Background and color sit in classes, not the inline style, so hover can change them.
const LINK_CLASS = "bg-transparent text-[var(--color-secondary-fg)] hover:bg-[var(--color-muted)] hover:text-[var(--color-fg)]";

const linkStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid transparent",
  fontFamily: SANS_FONT,
  fontSize: 12,
  cursor: "pointer",
} as const;

/**
 * The other ways to add a project, under Add project's form: open a folder
 * that is already on a computer, or start a new empty project. With other
 * computers connected, a picker says on which computer (the old first step
 * asked that before anything else).
 */
export function AddProjectMoreActions({
  places,
  placeKey,
  onPlaceChange,
  onOpenFolder,
  onCreate,
}: {
  /** This computer first, then each connected computer. */
  places: readonly AddProjectPlace[];
  placeKey: string;
  onPlaceChange: (key: string) => void;
  onOpenFolder: () => void;
  onCreate: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 4,
        paddingTop: 12,
        borderTop: `1px solid ${COLORS.border}`,
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textMuted,
      }}
    >
      <button
        type="button"
        style={linkStyle}
        className={LINK_CLASS}
        onClick={onOpenFolder}
      >
        <FolderOpen size={14} weight="regular" aria-hidden />
        Open a folder…
      </button>
      <button
        type="button"
        style={linkStyle}
        className={LINK_CLASS}
        onClick={onCreate}
      >
        <FolderPlus size={14} weight="regular" aria-hidden />
        New empty project…
      </button>
      {places.length > 1 ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          on
          <select
            value={placeKey}
            onChange={(event) => onPlaceChange(event.target.value)}
            aria-label="Computer for the folder or new project"
            style={{
              height: 28,
              minWidth: 140,
              maxWidth: 220,
              padding: "0 8px",
              borderRadius: 6,
              border: `1px solid ${COLORS.border}`,
              background: fgTint(3),
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textPrimary,
            }}
          >
            {places.map((place) => (
              <option key={place.key} value={place.key}>{place.name}</option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
