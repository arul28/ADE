import React from "react";
import { Flag, Lightning, Shield, Star, Tag } from "@phosphor-icons/react";
import type { LaneIcon } from "../../../shared/types";

const LANE_ICON_OPTIONS: Array<{ key: LaneIcon; icon: React.ReactNode }> = [
  { key: null, icon: React.createElement("span", { className: "text-xs" }, "\u25CB") },
  { key: "star", icon: React.createElement(Star, { size: 14, weight: "regular" }) },
  { key: "flag", icon: React.createElement(Flag, { size: 14, weight: "regular" }) },
  { key: "bolt", icon: React.createElement(Lightning, { size: 14, weight: "regular" }) },
  { key: "shield", icon: React.createElement(Shield, { size: 14, weight: "regular" }) },
  { key: "tag", icon: React.createElement(Tag, { size: 14, weight: "regular" }) },
];

export function iconGlyph(icon: LaneIcon): React.ReactNode {
  return LANE_ICON_OPTIONS.find((option) => option.key === icon)?.icon ?? null;
}
