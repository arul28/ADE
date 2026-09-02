## Graph

Lanes, commits, PR overlays, conflict risk and sync presence, drawn on one
canvas. Selecting a node opens that lane.

This plugin replaces ADE's compiled Graph tab. Install it and the rail talks to
these panels. Disable it and the compiled Graph page comes back unchanged. The
canvas engine stays in ADE: desktop mounts the host workspace Graph (React
Flow); phone and terminal list the same bound lane rows.

### What it adds

- The **Graph** tab: a host-rendered workspace canvas plus a lane list on
  phone and in the terminal.
- A lane detail for the clients that cannot draw React Flow.
- Agent tools: `list_lanes`, `get_lane`.

### Notes

- Topology, conflict risk, PR overlays and the minimap stay in ADE. This plugin
  names the `workspace` canvas engine and publishes lane rows.
- Phone and terminal: there was never a compiled Graph screen. These panels are
  the first Graph UI on iOS and in the terminal.
