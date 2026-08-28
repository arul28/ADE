import type { CSSProperties } from "react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

export function PrCommentEditForm({
  editValue,
  setEditValue,
  editBusy,
  cancelEdit,
  saveEdit,
  ariaLabel,
  saveStyle,
  cancelStyle,
}: {
  editValue: string;
  setEditValue: (value: string) => void;
  editBusy: boolean;
  cancelEdit: () => void;
  saveEdit: () => void | Promise<boolean>;
  ariaLabel: string;
  saveStyle?: CSSProperties;
  cancelStyle?: CSSProperties;
}) {
  const disabled = editBusy || !editValue.trim();
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={editValue}
        onChange={(event) => setEditValue(event.target.value)}
        rows={4}
        autoFocus
        aria-label={ariaLabel}
        className="w-full resize-y rounded-[8px] border px-3 py-2 text-[12px] outline-none"
        style={{
          borderColor: COLORS.accent,
          background: COLORS.recessedBg,
          color: COLORS.textPrimary,
          fontFamily: SANS_FONT,
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={cancelEdit} style={cancelStyle}>
          Cancel
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void saveEdit()}
          style={{
            ...saveStyle,
            opacity: disabled ? 0.5 : saveStyle?.opacity ?? 1,
            cursor: disabled ? "not-allowed" : saveStyle?.cursor ?? "pointer",
          }}
        >
          {editBusy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
