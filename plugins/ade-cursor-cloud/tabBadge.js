"use strict";

/**
 * Unread count on the Cursor Cloud rail tab.
 *
 * The host draws a `row-badge` published against `ade-cursor-cloud/fleet`.
 * This module is the pure half: what to publish, and how the count moves.
 * The child duplicates the entity-id string rather than importing the host
 * helper — plugins are plain CJS with no `node_modules`.
 */

const TAB_ENTITY_ID = "ade-cursor-cloud/fleet";
const TAB_BADGE_SOCKET_ID = "tab-badge";
const TAB_BADGE_DISPLAY_CAP = 9;
const TAB_BADGE_COUNT_CAP = 99;

function tabBadgePayload(count) {
  const n = Math.max(0, Math.min(TAB_BADGE_COUNT_CAP, Math.trunc(Number(count)) || 0));
  if (n <= 0) return null;
  return {
    id: TAB_BADGE_SOCKET_ID,
    text: n > TAB_BADGE_DISPLAY_CAP ? `${TAB_BADGE_DISPLAY_CAP}+` : String(n),
    tone: "accent",
    tooltip: n === 1
      ? "1 finished cloud agent you have not opened"
      : `${n} finished cloud agents you have not opened`,
  };
}

function nextUnreadCount(current, bump) {
  const from = Math.max(0, Math.trunc(Number(current)) || 0);
  const delta = Math.trunc(Number(bump)) || 0;
  return Math.max(0, Math.min(TAB_BADGE_COUNT_CAP, from + delta));
}

function applyViewerCount(current, viewed) {
  const from = Math.max(0, Math.trunc(Number(current)) || 0);
  if (viewed) return from + 1;
  return Math.max(0, from - 1);
}

module.exports = {
  TAB_ENTITY_ID,
  TAB_BADGE_SOCKET_ID,
  TAB_BADGE_DISPLAY_CAP,
  TAB_BADGE_COUNT_CAP,
  tabBadgePayload,
  nextUnreadCount,
  applyViewerCount,
};
