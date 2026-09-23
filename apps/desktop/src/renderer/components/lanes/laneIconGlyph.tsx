import type { ReactNode } from "react";
import { Flag, Lightning, Shield, Star, Tag } from "@phosphor-icons/react";
import type { LaneIcon } from "../../../shared/types";

const LANE_ICON_OPTIONS: Array<{ key: LaneIcon; icon: ReactNode }> = [
  { key: null, icon: <span className="text-xs">{"○"}</span> },
  { key: "star", icon: <Star size={14} weight="regular" /> },
  { key: "flag", icon: <Flag size={14} weight="regular" /> },
  { key: "bolt", icon: <Lightning size={14} weight="regular" /> },
  { key: "shield", icon: <Shield size={14} weight="regular" /> },
  { key: "tag", icon: <Tag size={14} weight="regular" /> },
];

export function iconGlyph(icon: LaneIcon): ReactNode {
  return LANE_ICON_OPTIONS.find((option) => option.key === icon)?.icon ?? null;
}
