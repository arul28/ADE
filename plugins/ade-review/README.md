## Review

Run AI review passes over your project and pull requests, and read what they
found — findings, files and the run history behind them.

Review was part of ADE itself until plugins existed. Nothing about it changed —
it stopped being something everyone has to carry. Install it and the Review tab
is in your rail; remove it and the rail is one item shorter.

### What it adds

- The **Review** tab.

### Notes

- The page is drawn by the desktop app rather than published as a panel. On a
  phone or in the terminal the plugin shows a card pointing at the computer that
  holds the repository.
- The `/review` route and Review links open only while this plugin is installed
  and enabled. Otherwise ADE says plainly that it is not here.
- It runs no code at all: the card is `panels/main.json`, which ADE reads from
  the manifest. Nothing is read, and nothing is stored.
