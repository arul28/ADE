import type { ComponentType, ReactNode } from "react";
import {
  AppWindow,
  Bell,
  BellRing,
  Boxes,
  CalendarClock,
  Clapperboard,
  Columns3,
  Crown,
  FolderTree,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Layers,
  LayoutDashboard,
  Gauge,
  Globe,
  Import,
  LayoutGrid,
  Link2,
  ListTodo,
  MessageSquareQuote,
  Mic,
  Monitor,
  Moon,
  Palette,
  PanelRight,
  Plug,
  Repeat2,
  RotateCcw,
  Scale,
  Server,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Webhook,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { WindowsMark } from "./marks";

/*
 * Everything else ADE does, as one wall in the manner of Apple's feature
 * walls: tiles of many sizes packed into one grid, a bright tile at the
 * middle, the big features as large tiles with a screenshot, and small tiles
 * with an icon and one line. No filters. Every screenshot is the real app.
 */

type Icon = ComponentType<{ className?: string }>;

/** Grid cell spans at the large breakpoint: [columns, rows]. Narrower screens use simpler spans. */
type Span = "1x1" | "2x1" | "1x2" | "2x2" | "3x2" | "2x3" | "3x3" | "4x2";
const SPAN: Record<Span, string> = {
  "1x1": "col-span-1 row-span-1",
  "2x1": "col-span-2 row-span-1",
  "1x2": "col-span-1 row-span-2",
  "2x2": "col-span-2 row-span-2",
  "3x2": "col-span-2 row-span-2 lg:col-span-3",
  "2x3": "col-span-2 row-span-2 lg:row-span-3",
  "3x3": "col-span-2 row-span-2 md:col-span-4 md:row-span-3 lg:col-span-3",
  "4x2": "col-span-2 row-span-2 md:col-span-4",
};

function Tile({ span = "1x1", className, children }: { span?: Span; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-[28px] border border-white/[0.07] bg-[#111116]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-transform duration-500 ease-out hover:-translate-y-0.5",
        SPAN[span],
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A large feature: its name and one line on top, and a screenshot of the real
 * app that bleeds off the bottom-right corner, the way Apple shows a screen.
 * Each screenshot is one panel cut from the app at 140% zoom. It always fills
 * the tile's width, so no text is cut at the side; only the bottom runs off.
 */
function ScreenTile({
  span,
  icon: I,
  tint,
  title,
  body,
  src,
  alt,
  detail,
  glow,
}: {
  span: Span;
  icon: Icon;
  tint: string;
  title: string;
  body: string;
  src: string;
  alt: string;
  /** A smaller line under the headline. */
  detail?: string;
  glow: string;
}) {
  return (
    <Tile span={span} className="flex flex-col">
      <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(120% 90% at 100% 100%, ${glow}, transparent 60%)` }} />
      <div className="relative z-10 p-6 sm:p-7">
        <div className="flex items-center gap-2">
          <I className={cn("h-5 w-5", tint)} />
          <span className="text-[13px] font-medium text-white/55">{title}</span>
        </div>
        <div className="mt-2 max-w-[440px] text-[clamp(20px,1.7vw,26px)] font-semibold leading-[1.15] tracking-[-0.015em] text-white">{body}</div>
        {detail && <div className="mt-2 max-w-[520px] text-[14px] leading-snug text-white/55">{detail}</div>}
      </div>
      <div className="relative ml-6 mt-auto min-h-[120px] flex-1 sm:ml-10">
        <div className="absolute inset-0 overflow-hidden rounded-tl-[14px] border-l border-t border-white/10 bg-[#0b0b10] shadow-[0_-20px_60px_rgba(0,0,0,0.5)] transition-transform duration-700 ease-out group-hover:-translate-x-1 group-hover:-translate-y-1">
          <img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />
        </div>
      </div>
    </Tile>
  );
}

/** A small tile: an icon, a short name, one line. */
function Small({ span = "1x1", icon: I, title, body, tint, className }: { span?: Span; icon: Icon; title: string; body: string; tint: string; className?: string }) {
  return (
    <Tile span={span} className={cn("flex flex-col justify-between p-5 sm:p-6", className)}>
      <I className={cn("h-7 w-7", tint)} />
      <div>
        <div className="text-[17px] font-semibold leading-tight text-white">{title}</div>
        <div className="mt-1 text-[13px] leading-snug text-white/50">{body}</div>
      </div>
    </Tile>
  );
}

export function FeatureWall() {
  return (
    <section className="mx-auto max-w-[1320px] px-5 pb-[clamp(80px,10vw,140px)] pt-10 sm:px-8">
      <div className="grid auto-rows-[150px] grid-flow-dense grid-cols-2 gap-3 md:grid-cols-4 lg:auto-rows-[170px] lg:grid-cols-6">
        {/* The big four: tall, so each screenshot has room to read */}
        <ScreenTile
          span="3x3"
          icon={GitPullRequest}
          tint="text-emerald-400"
          title="Pull requests"
          body="Checks, reviews and merge, without opening GitHub."
          src="/images/home/wall/prs.webp"
          alt="ADE's pull request view: PR #1820 with its description, branch and checks"
          glow="rgba(16,185,129,0.22)"
        />
        <ScreenTile
          span="3x2"
          icon={GitBranch}
          tint="text-sky-400"
          title="Worktrees"
          body="Every task in its own worktree, with its chats, commits and changes."
          src="/images/home/wall/lanes.webp"
          alt="A worktree in ADE: its branch, one commit ahead of main, the chat that made it, and its activity"
          glow="rgba(56,189,248,0.2)"
        />
        <ScreenTile
          span="3x2"
          icon={Webhook}
          tint="text-orange-400"
          title="Automations"
          body="Run an agent on a schedule, or when a PR, an issue or a webhook fires."
          src="/images/home/wall/automations.webp"
          alt="ADE's automation builder: a GitHub issue opens a lane and runs an agent, with every trigger it can use"
          glow="rgba(251,146,60,0.2)"
        />

        <Small icon={Layers} title="Stacked PRs" body="Build PRs on top of each other. Merge in order." tint="text-emerald-300" />
        <Small icon={Bell} title="PR watch" body="Wakes the agent on new reviews and failed checks." tint="text-amber-400" />

        {/* The middle of the wall */}
        <Tile span="2x2" className="flex items-center justify-center border-0 bg-[linear-gradient(135deg,#7c3aed_0%,#a855f7_40%,#ec4899_78%,#f59e0b_100%)] text-center">
          <div className="px-6">
            <div className="text-[clamp(32px,3.2vw,48px)] font-semibold leading-[1.02] tracking-[-0.025em] text-white">
              Everything else,
              <br />
              built in.
            </div>
            <div className="mt-3 text-[14px] text-white/85">No plugins to find. It ships with ADE.</div>
          </div>
        </Tile>

        <ScreenTile
          span="3x2"
          icon={FolderTree}
          tint="text-indigo-300"
          title="Files"
          body="A full editor, with a diff for every change."
          src="/images/home/wall/files.webp"
          alt="ADE's file editor with a docs page open on a worktree, beside the project's files"
          glow="rgba(129,140,248,0.22)"
        />

        {/* Counted from models.dev, the catalog OpenCode connects through, plus each harness's own sign-in. */}
        <Tile span="1x1" className="flex flex-col items-center justify-center text-center">
          <div className="bg-gradient-to-b from-white to-white/45 bg-clip-text text-[54px] font-semibold leading-none tracking-[-0.05em] text-transparent">200+</div>
          <div className="mt-2 px-3 text-[13px] leading-snug text-white/55">model providers, one app</div>
        </Tile>
        <Small icon={Mic} title="Voice" body="Dictate, or talk with an agent out loud, live." tint="text-rose-400" />

        <PhoneTile />
        <ScreenTile
          span="3x3"
          icon={Import}
          tint="text-violet-300"
          title="Import your chats"
          body="Bring in past chats from Claude Code, Codex, Cursor and more, and keep going."
          src="/images/home/wall/import.webp"
          alt="ADE's import window: past Claude, Codex and Cursor chats on this computer, with one open"
          glow="rgba(167,139,250,0.2)"
        />

        <ScreenTile
          span="3x3"
          icon={LayoutDashboard}
          tint="text-sky-300"
          title="Home screen"
          body="Customize your home screen."
          detail="Pick from widgets for projects, pull requests, usage limits, machine health, weather, a focus timer, clipboard history, contributions, music and more."
          src="/images/home/wall/widgets.webp"
          alt="ADE's home page: projects, open pull requests, the weather and a 3D chart of a year of contributions, over a painted background"
          glow="rgba(125,211,252,0.18)"
        />
        <ScreenTile
          span="3x2"
          icon={Palette}
          tint="text-fuchsia-300"
          title="Themes and backgrounds"
          body="26 themes, your own colours, fonts and backgrounds."
          src="/images/home/wall/themes.webp"
          alt="ADE's appearance settings: 26 themes and a live preview over a painted background"
          glow="rgba(240,171,252,0.16)"
        />

        <ScreenTile
          span="3x2"
          icon={Clapperboard}
          tint="text-violet-300"
          title="Proof"
          body="Agents file screenshots and videos of what they did, with the chat."
          src="/images/home/wall/proof.webp"
          alt="An agent's answer with the screenshot it filed as proof, and the chat's proof drawer"
          glow="rgba(139,92,246,0.2)"
        />
        <Small icon={RotateCcw} title="Rewind files" body="Undo edits back to any message." tint="text-emerald-400" />
        <Small icon={Sparkles} title="Scenes" body="Live charts and views in the chat." tint="text-fuchsia-400" />
        <Small span="2x1" icon={PanelRight} title="Chat actions" body="Each chat's subagents, schedules, background tasks, sources and proof, in one pane." tint="text-sky-300" />

        <ScreenTile
          span="3x2"
          icon={LayoutGrid}
          tint="text-cyan-300"
          title="Grid view"
          body="Watch many chats work side by side."
          src="/images/home/wall/grid.webp"
          alt="Two agent chats side by side in ADE's grid view, with the chat list on the left"
          glow="rgba(103,232,249,0.16)"
        />
        <ScreenTile
          span="3x2"
          icon={MessageSquareQuote}
          tint="text-amber-300"
          title="Comments"
          body="Comment on any reply, then send it to the chat."
          src="/images/home/wall/comments.webp"
          alt="A comment on a highlighted line of an agent's reply, set to send with the next message"
          glow="rgba(252,211,77,0.16)"
        />
        <ScreenTile
          span="2x2"
          icon={Crown}
          tint="text-teal-300"
          title="CTO"
          body="A project manager for each project that knows its lanes, PRs and history."
          src="/images/home/wall/cto.webp"
          alt="ADE's CTO introducing itself: it runs point on the project and can drive ADE"
          glow="rgba(94,234,212,0.16)"
        />

        <Small span="2x1" icon={SquareTerminal} title="ade CLI" body="Agents and scripts drive every lane, chat and PR from the command line." tint="text-violet-300" />
        <Small icon={Repeat2} title="Hand off" body="Move a chat to another model or machine." tint="text-pink-300" />
        <Small icon={ListTodo} title="Issues" body="Linear, Jira and GitHub. Start work from any." tint="text-indigo-300" />

        <ScreenTile
          span="2x2"
          icon={Columns3}
          tint="text-lime-300"
          title="Board"
          body="Every chat on a board: needs you, working, waiting, done."
          src="/images/home/wall/board.webp"
          alt="ADE's Work board with columns for chats that need you, are working, are waiting, and are done"
          glow="rgba(190,242,100,0.14)"
        />
        <ScreenTile
          span="3x2"
          icon={Gauge}
          tint="text-orange-300"
          title="Usage"
          body="Limits, pace and spend for every plan, on every machine."
          src="/images/home/wall/spend.webp"
          alt="ADE's usage page: cost, sessions and pull requests, and the rate limits left on Claude, Codex, Copilot, Grok and OpenCode"
          glow="rgba(253,186,116,0.16)"
        />

        <ScreenTile
          span="3x2"
          icon={Moon}
          tint="text-indigo-300"
          title="Keep awake"
          body="Agents keep working while you are away, even with the lid closed."
          src="/images/home/wall/awake.webp"
          alt="ADE's setting to keep the Mac awake: never, while I'm away, or even with the lid closed"
          glow="rgba(165,180,252,0.16)"
        />
        <Small span="2x1" icon={Plug} title="ADE MCP" body="Let ChatGPT, Claude, Grok and other AI apps use ADE on your computer." tint="text-cyan-300" />
        <Small icon={Boxes} title="One MCP setup" body="Add a server once, every agent gets it." tint="text-cyan-400" />

        <Small span="2x1" icon={Globe} title="Web app" body="Control every machine and agent from a browser. It works like the desktop app." tint="text-blue-300" />
        <Small span="2x1" icon={Server} title="Headless brain" body="Run ADE on a server with no screen. Sign in, and it joins your other machines." tint="text-slate-300" />
        <Small span="2x1" icon={Scale} title="Smart balance" body="Spreads chats across all your accounts, so one plan never runs dry first." tint="text-lime-400" />

        <Small icon={CalendarClock} title="Scheduled sends" body="Write now, send later." tint="text-yellow-300" />
        <Small icon={Monitor} title="Mac desktop" body="A private screen agents drive, so yours stays free." tint="text-slate-300" />
        <Small icon={WindowsMark} title="Windows desktop" body="The same, on your PC." tint="text-sky-400" />
        <Small icon={AppWindow} title="App Control" body="Drives and records Electron apps." tint="text-teal-300" />
        <Small icon={Link2} title="Deep links" body="Link to any chat, file or PR." tint="text-violet-300" />
        <Small icon={BellRing} title="Notifications" body="Know when an agent needs you, on any device." tint="text-rose-300" />

        <ScreenTile
          span="3x2"
          icon={GitMerge}
          tint="text-pink-300"
          title="History graph"
          body="Every branch and commit, drawn."
          src="/images/home/wall/history.webp"
          alt="ADE's history: the commit graph across lanes, with an agent's commit selected"
          glow="rgba(249,168,212,0.16)"
        />
        <Tile span="3x2" className="flex items-center gap-6 p-6 sm:p-8">
          <div className="flex shrink-0 items-center gap-3">
            <AppleMusicIcon className="h-16 w-16" />
            <span className="grid h-16 w-16 place-items-center rounded-[15px] bg-black">
              <img src="/images/home/marks/spotify.svg" alt="" aria-hidden className="h-11 w-11" />
            </span>
          </div>
          <div>
            <div className="text-[24px] font-semibold leading-tight text-white">Music</div>
            <div className="mt-1 text-[14px] leading-snug text-white/55">Apple Music and Spotify while you work.</div>
          </div>
        </Tile>
      </div>
    </section>
  );
}

/** The iPhone app: a real screenshot of a chat, standing in its tile. */
function PhoneTile() {
  return (
    <Tile span="2x3" className="flex flex-col bg-[radial-gradient(120%_90%_at_50%_100%,#1d2a44_0%,#111116_65%)]">
      <div className="relative z-10 p-6 sm:p-7">
        <div className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-sky-300" />
          <span className="text-[13px] font-medium text-white/55">iPhone app</span>
        </div>
        <div className="mt-2 max-w-[440px] text-[clamp(20px,1.7vw,26px)] font-semibold leading-[1.15] tracking-[-0.015em] text-white">
          Every chat, terminal and simulator, in your pocket.
        </div>
      </div>
      <div className="relative mt-auto flex-1 overflow-hidden">
        <img
          src="/images/hero-v2/phone.webp"
          alt="A chat in the ADE iPhone app"
          loading="lazy"
          className="absolute left-1/2 top-1 w-[80%] -translate-x-1/2 rounded-t-[40px] border border-b-0 border-white/15 shadow-[0_-10px_60px_rgba(56,189,248,0.18)] transition-transform duration-700 ease-out group-hover:-translate-y-1"
        />
      </div>
    </Tile>
  );
}

/** Apple Music's app icon, drawn the same way ADE's own Music tab draws it. */
function AppleMusicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" role="img" aria-label="Apple Music">
      <defs>
        <linearGradient id="ade-wall-apple-music" x1="50" y1="100" x2="50" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FA233B" />
          <stop offset="1" stopColor="#FB5C74" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22.5" fill="url(#ade-wall-apple-music)" />
      <g fill="#fff">
        <path d="M38.2 25.6 L71.6 18.4 C72.9 18.1 74 19 74 20.4 V27.2 L38.2 34.9 Z" />
        <rect x="38.2" y="27" width="4.4" height="42.5" rx="1.2" />
        <rect x="69.6" y="20" width="4.4" height="42.5" rx="1.2" />
        <ellipse cx="32.4" cy="69.6" rx="9.6" ry="7.4" transform="rotate(-18 32.4 69.6)" />
        <ellipse cx="63.8" cy="62.6" rx="9.6" ry="7.4" transform="rotate(-18 63.8 62.6)" />
      </g>
    </svg>
  );
}
