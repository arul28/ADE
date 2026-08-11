## Graph

Lanes, commits, PR overlays, conflict risk and sync presence, drawn on one
canvas. Selecting a node opens that lane.

Graph was part of ADE itself until plugins existed. Nothing about it changed —
it stopped being something everyone has to carry. Install it and the Graph tab
is in your rail; remove it and the rail is one item shorter.

### What it adds

- The **Graph** tab.

### Notes

- The canvas is drawn by the desktop app rather than published as a panel, so
  the tab is the desktop's own page. On a phone or in the terminal the plugin
  shows a card pointing at the machine that holds the repository.
- The `/graph` route keeps working even with the tab hidden, so links minted
  before you removed it still open.
- It runs no code at all: the card is `panels/main.json`, which ADE reads from
  the manifest. Nothing is read, and nothing is stored.
