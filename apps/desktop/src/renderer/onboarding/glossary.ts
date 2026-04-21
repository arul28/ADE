export type Term = {
  id: string;
  term: string;
  shortDefinition: string;
  longDefinition: string;
  docUrl: string;
};

const DOCS = "https://www.ade-app.dev/docs";

export const GLOSSARY: Term[] = [
  {
    id: "lane",
    term: "Lane",
    shortDefinition: "A Git worktree that ADE manages — your per-task workspace.",
    longDefinition:
      "A Lane is a Git worktree: a real folder on disk with its own branch checked out. ADE watches it, runs your stack inside it, and scopes AI Workers to it. Every Lane is a worktree and every ADE worktree is a Lane — they're the same thing.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "worktree",
    term: "Worktree",
    shortDefinition: "A Git branch checked out in its own folder. In ADE, a worktree is a Lane.",
    longDefinition:
      "A worktree lets Git have more than one branch checked out at the same time, each in a separate folder. ADE uses a worktree for every Lane so your changes stay isolated. If you see 'worktree' and 'Lane' in ADE, they mean the same thing.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "primary-lane",
    term: "Primary Lane",
    shortDefinition: "The Lane that points at your project's main branch.",
    longDefinition:
      "The Primary Lane tracks your project's main branch — the branch every other Lane is compared to. Switching its branch changes what new Lanes are cut from.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "child-lane",
    term: "Child Lane",
    shortDefinition: "A Lane that stacks on top of another Lane.",
    longDefinition:
      "A Child Lane starts from a parent Lane's branch instead of the main branch, so its changes include the parent's. Use stacks to split a big change into smaller, reviewable Lanes.",
    docUrl: `${DOCS}/lanes/stacks`,
  },
  {
    id: "attached-lane",
    term: "Attached Lane",
    shortDefinition: "An existing Git worktree you've pointed ADE at.",
    longDefinition:
      "An Attached Lane is a worktree that lives outside `.ade/worktrees` but that ADE now tracks. You can leave it where it is or move it into `.ade/worktrees` to have ADE fully manage it.",
    docUrl: `${DOCS}/lanes/creating`,
  },
  {
    id: "mission",
    term: "Mission",
    shortDefinition: "A job you hand to ADE to complete.",
    longDefinition:
      "A Mission is a piece of work described in plain words. ADE breaks it into steps and runs them, usually in its own Lane with one or more Workers doing the job.",
    docUrl: `${DOCS}/key-concepts`,
  },
  {
    id: "worker",
    term: "Worker",
    shortDefinition: "An AI agent that does work inside a Lane.",
    longDefinition:
      "A Worker is an AI helper tied to a Lane. It can read files, run commands, and edit code. You can chat with it, and it can keep working on its own for a while.",
    docUrl: `${DOCS}/key-concepts`,
  },
  {
    id: "integration",
    term: "Integration",
    shortDefinition: "A connection to an outside tool like GitHub or Linear.",
    longDefinition:
      "An Integration links ADE to another service. Once it is set up, ADE can open pull requests, read issues, and keep your work in sync with tools you already use.",
    docUrl: `${DOCS}/guides/multi-agent-setup`,
  },
  {
    id: "stack",
    term: "Stack",
    shortDefinition: "A group of Lanes that build on each other.",
    longDefinition:
      "A Stack is a chain of Lanes where each one starts from the work of the Lane before it. Stacks let you split one big change into small, reviewable pieces.",
    docUrl: `${DOCS}/lanes/stacks`,
  },
  {
    id: "pack",
    term: "Pack",
    shortDefinition: "A reusable bundle of context ADE can load into work.",
    longDefinition:
      "A Pack is a small folder of notes and files about part of your project. Workers can pull in a Pack to get the background they need before they start.",
    docUrl: `${DOCS}/lanes/packs`,
  },
  {
    id: "pinned",
    term: "Pinned",
    shortDefinition: "A Lane you have kept open so it stays visible.",
    longDefinition:
      "Pinning a Lane keeps its tab around even when you close other Lanes. Pinned Lanes cannot be closed by accident — you have to unpin them first.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "dirty",
    term: "Dirty",
    shortDefinition: "A Lane with changes that have not been saved to Git yet.",
    longDefinition:
      "A Dirty Lane has edits that are not committed. The changes are safe on disk, but they have not been recorded as a Git commit, so you could lose them if you are not careful.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "behind",
    term: "Behind",
    shortDefinition: "A Lane that is missing newer commits from its base.",
    longDefinition:
      "A Behind Lane is one whose base branch has moved forward since the Lane started. To catch up, you usually rebase the Lane onto the latest base so it has those new commits too.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "rebase",
    term: "Rebase",
    shortDefinition: "Move your changes on top of the newest base branch.",
    longDefinition:
      "Rebasing replays the commits in your Lane on top of the latest base branch. It keeps your history tidy and brings your Lane up to date without a merge commit.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "conflict",
    term: "Conflict",
    shortDefinition: "Two changes to the same lines that Git cannot merge.",
    longDefinition:
      "A Conflict happens when your Lane and its base both changed the same part of a file in different ways. You have to pick which change to keep, or combine them by hand, before Git can continue.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "running",
    term: "Running",
    shortDefinition: "A session in this Lane is working right now.",
    longDefinition:
      "A Running Lane has at least one chat or shell doing something active. You do not need to do anything — just wait for it to finish or check its progress.",
    docUrl: `${DOCS}/chat/overview`,
  },
  {
    id: "awaiting-input",
    term: "Awaiting Input",
    shortDefinition: "A session is paused and waiting for you to answer.",
    longDefinition:
      "Awaiting Input means a Worker or shell has a question for you, or is asking permission to do something. The Lane will stay paused until you reply.",
    docUrl: `${DOCS}/chat/overview`,
  },
  {
    id: "ended",
    term: "Ended",
    shortDefinition: "A session that has finished or stopped.",
    longDefinition:
      "An Ended session has stopped on its own or been closed. The Lane is still there — you can open a new chat or shell in it whenever you want to keep working.",
    docUrl: `${DOCS}/chat/overview`,
  },
  {
    id: "compaction",
    term: "Compaction",
    shortDefinition: "Squeezing a long chat into a short summary.",
    longDefinition:
      "When a chat gets long, ADE can compact it. That means it replaces older messages with a short summary so the Worker can keep going without losing the thread.",
    docUrl: `${DOCS}/chat/context`,
  },
  {
    id: "workspace",
    term: "Workspace",
    shortDefinition: "A folder ADE is tracking — either the primary project or a lane worktree.",
    longDefinition:
      "A Workspace is a root folder that ADE can browse and edit. The primary workspace is your main project folder. Each Lane gets its own workspace scoped to its worktree, so files stay isolated between branches.",
    docUrl: `${DOCS}/lanes/overview`,
  },
  {
    id: "process",
    term: "Process",
    shortDefinition: "A named command that ADE can start, stop, and monitor.",
    longDefinition:
      "A Process is a command definition saved in your project config. ADE can start it on demand or automatically, restart it on failure, and surface its logs in the Process Monitor. Processes run inside a lane's worktree so they see that branch's files.",
    docUrl: `${DOCS}/lanes/stacks`,
  },
];

export function findTerm(termId: string): Term | undefined {
  return GLOSSARY.find((t) => t.id === termId);
}
