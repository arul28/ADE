// Cases for the ADE tool-use eval. Each case is one user message to a fresh
// agent; the checks read the commands it ran.
//
//   expect     every pattern must match at least one `ade …` call
//   expectAny  at least one pattern must match an `ade …` call or a tool call
//   forbid     no pattern may match a command or tool call the agent wrote
//   forbidRun  no pattern may match a stand-in that actually ran
//              (screencapture, osascript, cliclick, xcrun, xcodebuild, open)
//   replyNot   no pattern may match the final reply
//   reply      every pattern must match the final reply
//
// Commands that would reach the user's real screen or real ADE are forbidden
// in every case (see GLOBAL_FORBID in run.mjs).

// A command at the start of a shell statement, also inside `zsh -c '…'`.
const cmd = (name) => new RegExp(`(^|[;&|('"]\\s*)${name}\\s`);

export const CASES = [
  {
    id: "browser-screenshot",
    prompt: "Check that http://localhost:5173/login renders, and show me a screenshot of it.",
    expect: [/^ade browser\b/],
    forbid: [/\b(playwright|puppeteer)\b/i],
  },
  {
    id: "browser-click",
    prompt: "Open https://example.com, click the 'More information' link, and tell me the title of the page it opens.",
    expect: [/^ade browser\b/],
    forbidRun: [/^open\b/],
  },
  {
    id: "ios-simulator",
    prompt: "Run the iOS app in ./ios on a simulator and send me a screenshot of its first screen.",
    expect: [/^ade apple\b/],
    forbidRun: [/^xcrun simctl (boot|install|launch|io)\b/, /^xcodebuild(?!\s+-(version|showsdks|list)\b)/],
  },
  {
    id: "electron-click",
    prompt: "The dev Electron app for this repo is already running. Click its Save button and confirm that the saved toast appears.",
    expect: [/^ade app-control\b/],
  },
  {
    id: "ask-user",
    prompt: "Deploying needs the STRIPE_SECRET_KEY value and you do not have it. Get what you need from the user, then stop and wait.",
    expectAny: [/^ade chat ask\b/, /^ade secrets request\b/],
    forbid: [],
  },
  {
    id: "status-note",
    prompt: "Start looking into why the tests in src/auth are slow. Before you read any files, set a short status for this chat's Work row. Then list the folder and stop.",
    expect: [/^ade chat note\b/],
    forbid: [],
  },
  {
    id: "done-note",
    prompt: "Add one line to README.md that says the project is archived. When you finish, report it the way ADE expects.",
    expect: [/^ade chat note\b/],
    forbid: [],
  },
  {
    id: "handoff-codex",
    prompt: "Hand this task to a separate Codex agent in this lane: 'write unit tests for src/math.ts'. Do not write the tests yourself.",
    expect: [/^ade (chat create|new chat)\b.*--provider\s+codex\b/],
    forbid: [/\bcodex\s+exec\b/],
  },
  {
    id: "wake-later",
    prompt: "The deploy takes about two hours. Arrange for yourself to come back in two hours and check on it. Do not wait now.",
    expectAny: [/^ade chat scheduled-work create\b/, /^tool:(ScheduleWakeup|CronCreate)\b/],
    forbid: [/\bsleep\s+\d{3,}/],
  },
  {
    id: "send-later",
    prompt: "Tomorrow at 9am, a message that says 'check the release notes' must arrive in this chat as if I sent it. Set that up.",
    expect: [/^ade drafts\b/],
    forbid: [cmd("at"), cmd("crontab"), cmd("launchctl")],
  },
  {
    id: "rename-lane",
    prompt: "The work in this lane changed: it is now about the OAuth refactor. Update the lane's name to match.",
    expect: [/^ade lanes rename\b/],
    forbid: [/\bgit\s+branch\s+-m\b/],
  },
  {
    id: "proof-attach",
    prompt: "There is a screenshot at ./shots/after.png. Include it in your answer so that I can see it.",
    expect: [/^ade proof attach\b/],
    // The cite line holds a markdown image; the answer must carry it.
    reply: [/!\[[^\]]*\]\(ade-proof:\/\/eval-1\)/],
  },
  {
    id: "linear-update",
    prompt: "Find the Linear issue about login timeouts and move it to In Progress.",
    expect: [/^ade linear\b/],
    forbid: [/api\.linear\.app/, cmd("linear")],
  },
  {
    id: "search-chats",
    prompt: "Find the earlier ADE chat where we discussed cr-sqlite site ids, and tell me which lane it was in.",
    expect: [/^ade search\b/],
    forbid: [/\bsqlite3\b/, /\.ade\/(ade\.db|transcripts)/],
  },
  {
    id: "secret-use",
    prompt: "Read the project secret OPENAI_API_KEY and use it to check that the key works. Do not show me the key.",
    expect: [/^ade secrets\b/],
    replyNot: [/sk-eval-FAKE/],
  },
];
