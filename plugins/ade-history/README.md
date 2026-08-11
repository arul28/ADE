## History

Commits, lane operations, branch links and the artifacts ADE captured along the
way — everything that already happened in this project, in one place.

History was part of ADE itself until plugins existed. Nothing about it changed —
it stopped being something everyone has to carry. Install it and the History tab
is in your rail; remove it and the rail is one item shorter.

### What it adds

- The **History** tab.

### Notes

- The page is drawn by the desktop app rather than published as a panel. On a
  phone or in the terminal the plugin shows a card pointing at the computer that
  holds the repository.
- The `/history` route and artifact links open only while this plugin is
  installed and enabled. Otherwise ADE says plainly that it is not here.
- It runs no code at all: the card is `panels/main.json`, which ADE reads from
  the manifest. Nothing is read, and nothing is stored.
