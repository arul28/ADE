## iOS Simulator

Drive an iOS Simulator from ADE — boot it, tap and type in it, watch the screen,
and open it beside the chat that is building the app.

Simulator control was part of ADE itself until plugins existed. Nothing about it
changed — it stopped being something everyone has to carry, including the people
who never open Xcode.

### What it adds

- The **iOS Simulator** pane in the Work tools, and its chat drawer.

### Notes

- It needs a Mac. On anything else the pane stays hidden even with the plugin
  installed.
- The pane is drawn by the desktop app rather than published as a panel, because
  it drives a real simulator. On a phone or in the terminal the plugin shows a
  card pointing at the Mac.
- Agents can open the drawer with `ade ios-sim` — but only while this plugin is
  installed and enabled.
- It runs no code at all: the card is `panels/main.json`, which ADE reads from
  the manifest. Nothing is read, and nothing is stored.
