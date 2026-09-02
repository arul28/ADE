---
name: ade-graph
description: >
  Use this skill when the task is ADE Graph — the workspace topology canvas of
  lanes, stacks, conflict risk and PR overlays. Prefer the plugin tools over
  inventing a second map of the project.
---

# ADE Graph

ADE already draws the workspace Graph. You do not start a second topology tool
in chat unless the user asked for that.

## Commands

Prefer the plugin tools (`list_lanes`, `get_lane`) when ADE exposed them on
this session. The Graph tab itself is the canvas: desktop mounts ADE's host
workspace Graph; phone and terminal list the same lanes.

There is no `ade graph` CLI word. Lane verbs stay on `ade lanes`.

## Rules

- The canvas is a projection of lanes, conflicts, PRs and git. Change those,
  not a separate graph store.
- Opening a lane from the Graph is a navigation. Do not delete or reparent a
  lane because it is on screen.
