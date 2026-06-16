import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { Masthead } from "../../components/editorial/Masthead";
import { CompetitorEquation } from "../../components/editorial/CompetitorEquation";
import { Lede } from "../../components/editorial/Lede";
import { DeviceComposition } from "../../components/editorial/DeviceComposition";
import { HeroAgentBadges } from "../../components/editorial/HeroAgentBadges";
import { ShipShowcase } from "../../components/editorial/ShipShowcase";
import { FadeBand } from "../../components/editorial/FadeBand";
import {
  Chapter,
  ChapterBody,
  Byline,
} from "../../components/editorial/Chapter";
import { ChapterHeadline } from "../../components/editorial/ChapterHeadline";
import { Cutout } from "../../components/editorial/Cutout";
import { PullQuote } from "../../components/editorial/PullQuote";
import { IPhoneFrame } from "../../components/editorial/IPhoneFrame";
import { FeatureGrid } from "../../components/editorial/FeatureGrid";
import { IndexPage } from "../../components/editorial/IndexPage";
import { BackCover } from "../../components/editorial/BackCover";
import { EDITORIAL_ISSUE } from "../../components/editorial/issue";

const MOBILE_BYLINE_DATE = `${EDITORIAL_ISSUE.monthYear} · iOS 17+`;

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      {/* ═══════ DARK COVER ═══════ */}
      <section className="relative overflow-x-clip bg-[color:var(--color-bg)] text-[color:var(--color-cream)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              "radial-gradient(ellipse 70% 50% at 70% 45%, rgba(124,58,237,0.3) 0%, transparent 70%)",
              "radial-gradient(ellipse 45% 55% at 10% 0%, rgba(167,139,250,0.08) 0%, transparent 70%)",
              "radial-gradient(ellipse 40% 30% at 40% 90%, rgba(124,58,237,0.08) 0%, transparent 70%)",
            ].join(", "),
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        <Masthead />

        <div className="relative mx-auto max-w-[1760px] px-[clamp(20px,3vw,48px)]">
          <div className="mx-auto flex w-full max-w-[1760px] flex-col items-center gap-[clamp(32px,4vw,56px)] pb-[clamp(20px,3vw,40px)] pt-0">
            <div className="relative w-full min-w-0 overflow-visible">
              {/* Badges span the full hero height (headline + devices) so they
                  scatter through the upper empty gutters, not just beside the
                  device stack. */}
              <HeroAgentBadges />
              <div className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-col items-center gap-[clamp(4px,1vw,12px)]">
                <CompetitorEquation />
                <Lede />
              </div>
              <div className="relative z-0 w-full min-w-0 overflow-visible px-[clamp(8px,2vw,32px)] py-[clamp(12px,2vw,24px)]">
                <DeviceComposition />
              </div>
            </div>
            <ShipShowcase />
          </div>
        </div>
      </section>

      {/* ═══════ FADE dark → cream ═══════ */}
      <FadeBand direction="to-cream" />

      {/* ═══════ CHAPTER I — WORKTREES ═══════ */}
      <Chapter
        chapterNumber="Chapter I"
        chapterTitle="Worktrees"
        pageNumber="04"
        id="chapter-lanes"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:items-center">
          <Cutout
            src="/images/screenshots/lanes.png"
            alt="ADE worktrees — parallel git branches on macOS"
            figNumber="Fig. 2"
            caption="Worktrees in parallel — each its own git branch. Switch in a click."
            rotate={0.4}
            tone="ink"
          />

          <div>
            <ChapterHeadline
              line1="Manage worktrees."
              line2="In parallel."
              deck="Every task gets its own git worktree. Branch, edit, test, and commit side by side — no stashing, no rebasing, no context switch."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                Each worktree is a fresh branch you flip between in a click.
                Tests running in one don&rsquo;t block code in another. When a
                worktree ships, commit it and move on.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;Parallel branches. One repo. No stash, no rebase.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>
        </div>
      </Chapter>

      {/* ═══════ CHAPTER II — WORK ═══════ */}
      <Chapter
        chapterNumber="Chapter II"
        chapterTitle="Work"
        pageNumber="10"
        id="chapter-work"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-center">
          <div>
            <ChapterHeadline
              line1="Every coding agent."
              line2="One workspace."
              deck="Claude Code, Codex, Cursor, opencode — pick whichever model fits the task. All of them run against the same worktree, with live diffs and approval gates."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                Attach a prompt to a worktree, pick your agent, and step through
                every file change, test run, and tool call as it happens.
                Approve the diff before it commits, or step in and steer.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;Every agent worth using. On one surface.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>

          <div className="relative">
            <Cutout
              src="/images/screenshots/run.png"
              alt="ADE run view — an agent executing a task live"
              figNumber="Fig. 3"
              caption="An agent executing — tool calls, test output, and a diff ready for review."
              rotate={-0.5}
              tone="ink"
            />
          </div>
        </div>
      </Chapter>

      {/* ═══════ CHAPTER III — PULL REQUESTS ═══════ */}
      <Chapter
        chapterNumber="Chapter III"
        chapterTitle="Pull Requests"
        pageNumber="16"
        id="chapter-prs"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:items-center">
          <Cutout
            src="/images/screenshots/prs.png"
            alt="ADE pull request review"
            figNumber="Fig. 4"
            caption="Pull requests — diff, CI status, and review comments on the same page as the worktree."
            rotate={0.5}
            tone="ink"
          />

          <div>
            <ChapterHeadline
              line1="Open, review,"
              line2="and merge PRs."
              deck="Every PR your agents open lands in ADE — diff, CI, comments, merge button. No GitHub tab. Auto-merge when green."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                Read the diff, check CI, comment, approve, merge &mdash; all
                inside ADE, connected to the worktree, the branch, and the
                agent that wrote the code.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;Green build. One click. Merged.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>
        </div>
      </Chapter>

      {/* ═══════ CHAPTER IV — CTO ═══════ */}
      <Chapter
        chapterNumber="Chapter IV"
        chapterTitle="CTO"
        pageNumber="22"
        id="chapter-cto"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-center">
          <div>
            <ChapterHeadline
              line1="The conductor"
              line2="for your agents."
              deck="One CTO, always on, with context across every worktree. Pulls work from Linear, dispatches to the right worker, reports back when it's done."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                The CTO knows what each worker is good at, what&rsquo;s in
                flight, and what Linear wants next. It dispatches, tracks, and
                posts results &mdash; turning a pile of prompts into a shipping
                team.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;A team of agents. On payroll. On call.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>

          <Cutout
            src="/images/screenshots/cto.png"
            alt="ADE CTO — org chart of worker agents"
            figNumber="Fig. 5"
            caption="The CTO — an org chart of worker agents, each with its own budget."
            rotate={-0.4}
            tone="ink"
          />
        </div>
      </Chapter>

      {/* ═══════ CHAPTER V — IN YOUR POCKET ═══════ */}
      <Chapter
        chapterNumber="Chapter V"
        chapterTitle="In Your Pocket"
        pageNumber="28"
        id="chapter-mobile"
      >
        <div className="grid grid-cols-1 items-center gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <ChapterHeadline
              line1="Everything above."
              line2="On your phone."
              deck="Every worktree, every agent, every PR — synced to iOS over cr-sqlite. Start a task on macOS, approve the diff from the train."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                The desktop is where code gets written. The pocket is where
                decisions get made. ADE syncs both so a worktree you started on
                macOS continues on iOS without a refresh.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;None of the ten apps we replace have a mobile client.
                We built the one that does.&rdquo;
              </PullQuote>
              <Byline tone="ink" date={MOBILE_BYLINE_DATE} />
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[560px]">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -m-10"
              style={{
                background:
                  "radial-gradient(ellipse 65% 55% at 50% 45%, rgba(124,58,237,0.38) 0%, rgba(124,58,237,0.08) 48%, transparent 78%)",
                filter: "blur(14px)",
              }}
            />

            {/* Left phone (behind) */}
            <div className="absolute left-[-4%] top-[48px] z-[1] hidden md:block">
              <IPhoneFrame
                src="/images/screenshots/mobile-worktrees.png"
                alt="ADE on iPhone — worktrees"
                rotate={-13}
                width="w-[180px] lg:w-[200px]"
              />
            </div>

            {/* Right phone (behind) */}
            <div className="absolute right-[-4%] top-[72px] z-[1] hidden md:block">
              <IPhoneFrame
                src="/images/screenshots/mobile-pr.png"
                alt="ADE on iPhone — pull requests"
                rotate={11}
                width="w-[180px] lg:w-[200px]"
              />
            </div>

            {/* Center phone (front, with caption) */}
            <div className="relative z-[3] flex justify-center">
              <IPhoneFrame
                src="/images/screenshots/agent-chat.png"
                alt="ADE on iPhone — agent chat"
                rotate={-2}
                width="w-[260px] sm:w-[280px]"
                figCaption={{
                  figNumber: "Fig. 6",
                  caption:
                    "A worktree, synced from desktop — edit, approve, comment from anywhere.",
                  tone: "ink",
                }}
              />
            </div>
          </div>
        </div>
      </Chapter>

      {/* ═══════ CATALOG — the rest of the IDE ═══════ */}
      <FeatureGrid />

      {/* ═══════ FADE cream → dark ═══════ */}
      <FadeBand direction="to-dark" />

      {/* ═══════ BACK COVER ═══════ */}
      <BackCover />

      {/* ═══════ FADE dark → cream ═══════ */}
      <FadeBand direction="to-cream" />

      {/* ═══════ INDEX ═══════ */}
      <IndexPage />
    </Page>
  );
}
