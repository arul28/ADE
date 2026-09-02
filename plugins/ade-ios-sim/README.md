## iOS Simulator

Drive an iOS Simulator from ADE — boot it, tap and type in it, watch the screen,
and open it beside the chat that is building the app.

This plugin replaces ADE's compiled Simulator pane. Install it and the Work
tools talk to this package. Disable it and the compiled pane comes back
unchanged. simctl and idb stay in ADE.

### What it adds

- The **iOS Simulator** pane in the Work tools.
- A `get_status` tool. Launch, tap, type and screenshot stay on `ade ios-sim`.

### Notes

- It needs a Mac. On anything else the compiled pane stays hidden, and this
  plugin lists a status row pointing at the Mac.
- Desktop mounts ADE's compiled Simulator pane through a host canvas engine.
  Phone and terminal never run a simulator.
- Agents keep using `ade ios-sim` — those verbs stay on the host.
