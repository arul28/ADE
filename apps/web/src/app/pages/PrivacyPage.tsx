import { useEffect, useState } from "react";
import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import {
  isMarketingAnalyticsEnabled,
  onMarketingAnalyticsPreferenceChange,
  setMarketingAnalyticsEnabled,
} from "../../lib/marketingAnalyticsBrowser";

/**
 * The date of the latest change. When it changes, also change
 * `PRIVACY_POLICY_VERSION` in `apps/desktop/src/shared/legalLinks.ts` and
 * `PrivacyPolicyNotice.version` in `apps/ios/ADE/App/ContentView.swift`, so the
 * apps show their one-time "We updated our Privacy Policy" notice again, and add
 * a dated entry to `changelog` below.
 */
const LAST_UPDATED = "November 25, 2026";
const CONTACT_EMAIL = "arulsharma1028@gmail.com";

type Section = {
  title: string;
  /** The section's anchor (`/privacy#<id>`), for links from the apps. */
  id: string;
  body: Array<string | { list: string[] }>;
  analyticsControl?: boolean;
};

/** Sponsored cards (Gravity). The apps link to `/privacy#sponsored` from every card and the consent prompt. */
const sponsoredSection: Section = {
  id: "sponsored",
  title: "Sponsored cards on the ADE Cloud Free plan",
  body: [
    "On the ADE Cloud Free plan, ADE works with Gravity (IRIS Inc., trygravity.com), its ad partner, to show sponsored cards in the ADE apps (desktop, the web app, and iPhone and iPad). A card is labeled “Sponsored” and shows under a finished reply, above the prompt box, or at the end of the reply, at most one per reply. An agent may also suggest a sponsored tool for something you need. Paid plans, chats on your own computer, and this website have no ads.",
    "In the United States, except California, sponsored cards start on: your first ADE Cloud chat (or Settings › ADE Cloud) tells you they are on, with a button to turn them off. In California and everywhere else, ADE asks first and cards show only after you agree. In the United States, a browser that sends a Global Privacy Control (GPC) signal turns them off (see below).",
    "While they are on, and only for chats running on ADE Cloud computers, ADE's server sends Gravity:",
    {
      list: [
        "the last messages of that chat (your latest request and the reply),",
        "your IP address, and your device type, operating system and version, and the app's user agent,",
        "an ID for your account and a session ID for the chat, both scrambled one way so they do not reveal your ADE account or chat, and",
        "a SHA-256 hash of your account email (never the email itself).",
      ],
    },
    "In the ADE app for iPhone and iPad, ADE first asks with Apple's App Tracking Transparency prompt. The email hash is sent only if you allow tracking there; if you don't, sponsored cards still show and ADE sends everything above except the email hash.",
    "When an agent asks for a tool recommendation, ADE sends Gravity the need the agent described, the session ID and email hash above (the hash under the same rule), and the IP address, country and device of your latest visit to that computer's chats. In a CLI session on ADE Cloud, that request is all that is sent; never the terminal's output.",
    "When a card shows, your app loads it from Gravity's design and tells Gravity directly that the card was seen and how much of it was on screen; when you open a card, the link goes through Gravity first, so Gravity can count the click. Gravity receives your IP address and your app or browser's details with those requests.",
    "Gravity receives this as an independent controller. Under section 7 of Gravity's Terms it keeps a perpetual license to use what ADE sends, and it may not delete it when you ask. Gravity's own privacy policy is at https://trygravity.com/privacy.",
    "ADE never sends anything from chats on your own computer or from paid plans. ADE sends no file contents beyond what is in those messages.",
    "You can turn this off at any time in Settings › ADE Cloud. After that, nothing is sent and no cards show.",
    "Under California and other US state privacy laws, sending this to Gravity for ads can be a “sale” or “sharing” of personal information. Turning sponsored cards off is how you opt out; if you do that in the United States, ADE won't ask you to turn them back on for 12 months, and turning them back on yourself takes two steps: you choose it, then confirm it. In the United States, a browser that sends a Global Privacy Control signal opts your whole account out: the first time ADE sees it, sponsored cards turn off on all your devices (or stay off, if you never turned them on), and Settings › ADE Cloud says why. If you then turn them on from that browser, again in two steps, ADE takes that as your choice and keeps them on.",
    "Notice of financial incentive: on the Free plan, Small ADE Cloud computers are free while sponsored cards are on. With them off, Small computers use credits, half a credit for each hour awake. The cards pay for that computer time, so ADE's good-faith estimate of the value of the data above is what that time costs: half a credit for each hour a Small computer is awake. In California, ADE asks you first and enters you only after you agree. You can withdraw at any time by turning the cards off in Settings › ADE Cloud, and turn them back on there.",
    "ADE keeps the IP address, country, state and device of your latest visit to an ADE Cloud chat (replaced on each visit, and deleted about a day after your last visit, at most 25 hours, or at once when you turn sponsored cards off), the sponsored card shown for a reply for about a day, and daily counts of requests, cards shown and cards hidden for reporting. It keeps none of your messages for this. All of it is deleted with your account.",
  ],
};

const sections: Section[] = [
  {
    id: "summary",
    title: "Summary",
    body: [
      "ADE runs coding agents on your own computers and on ADE Cloud computers. Your code, git history and terminals live on the computer that runs the lane. ADE also sends some data to its own servers and to other companies so that its features work and so that ADE can find and fix problems. This page lists all of it. These items are on by default:",
      {
        list: [
          "Product analytics, session replay, error reports and automatic diagnostic reports. The apps have no switch for these. On the desktop app, the main way to stop them is the DO_NOT_TRACK=1 setting, described under Your choices. The iPhone app has no way to stop them.",
          "When you are signed in, ADE copies your GitHub CLI (gh) login to your ADE account, so that your other computers and ADE Cloud can use it. It does not ask first.",
          "When you are signed in, ADE copies the logins of most AI coding tools on your computer (for example Codex and Cursor) to your ADE account, so that ADE Cloud computers can use them. It does not copy Claude Code's login.",
          "Smart decisions sends parts of your chats, the prompt you are typing, and the last lines of idle ADE terminals to a small AI model run by OpenCode or TypeSafe.",
          "Error reports can include the last lines of ADE's logs, which can hold file paths and parts of chat text.",
          "Your account server keeps the names of your computers, projects, lanes and branches, and the folder paths of your projects, so that every device you sign in on can show them.",
          "On the ADE Cloud Free plan, while sponsored cards are on (in the United States, except California, they start on), ADE sends the last messages of ADE Cloud chats, your IP address and device, and scrambled IDs to Gravity, its ad partner, to show sponsored cards. See Sponsored cards.",
        ],
      },
      "Product analytics never includes prompts, code, file contents or terminal output. The sections below say exactly what goes where, how long it is kept, and what you can turn off.",
    ],
  },
  {
    id: "account",
    title: "Your ADE account",
    body: [
      "You need an ADE account to use ADE. Clerk runs sign-in for ADE. When you sign up or sign in, Clerk and ADE's account server receive your email address, your name and profile picture if your sign-in method gives them (Apple, Google or GitHub), how you signed in, and an account ID. Clerk also records the device and network address of each sign-in for security.",
      "ADE's account server keeps your plan, your ADE Cloud credits and usage, and your billing status. Stripe handles payments. ADE does not see or store your full card number.",
      "When you create an account, ADE's account service records one sign-up event in product analytics with how you signed up (for example GitHub, Google or email).",
      "About a day after you sign up, ADE sends one getting-started email through Resend. It greets you by your first name when your account has one. Every email has an unsubscribe link. ADE also sends emails about your account, your plan and your ADE Cloud computers. When you share a lane with someone, ADE emails the invite, with your name, to the address you enter.",
      "To give the ADE Cloud Free plan, ADE checks that your connected GitHub account is at least 30 days old and gives the free plan once per GitHub account and once per computer. For the computer check, ADE keeps a scrambled ID made from your operating system's machine ID; the server keeps only a keyed hash of it.",
      "ADE's account server also keeps a keyed hash of the IP address you signed up from, to find bulk sign-ups. It is deleted with the account.",
      "You can delete your account in the app (Account › Delete account). Deletion removes what ADE's servers keep for the account, including the items in the next sections, with the exceptions under Retention. Analytics, error reports and diagnostic reports are not removed with the account; they follow the times under Retention.",
    ],
  },
  {
    id: "sync",
    title: "What your account server keeps so your devices stay in sync",
    body: [
      "ADE shows the same projects, computers and chats on every device you sign in on. To do that, each signed-in computer sends ADE's account server:",
      {
        list: [
          "the computer's name, operating system, ADE version, the network addresses other devices can use to reach it, the path of its ADE folder, and a hashed hardware ID;",
          "the GitHub repositories you opened in ADE in the last 90 days (owner, name and default branch) and the folder path of each one on that computer;",
          "a list of your lanes, with each lane's name, branch name and pull request number;",
          "your account-wide settings.",
        ],
      },
      "These items are stored as readable data on the account server (Cloudflare), because every device must be able to show them. They are not product analytics.",
    ],
  },
  {
    id: "logins",
    title: "Logins, keys and passwords ADE saves to your account",
    body: [
      "ADE keeps some logins in your account so that you sign in once and your other computers, the web app and ADE Cloud computers can use them:",
      {
        list: [
          "GitHub CLI login. When you are signed in to ADE and to the gh tool on a computer, ADE reads gh's login token and saves it to your ADE account automatically, with no question. Your other computers then use it for git and GitHub. A GitHub token you paste into ADE is saved to your account too. You can take the gh login off your account in Settings › GitHub.",
          "AI tool logins. On each signed-in computer, ADE checks the login files of these tools about every 30 seconds and saves a changed login to your account. For most tools the saved copy is the whole login file, which can include the refresh token and the email of that tool's account. The tools are: Codex, Cursor (the key that its sign-in made), Grok, Droid, Kimi, Qwen (its key settings, not a Qwen OAuth sign-in), Devin, OpenCode (only its opencode.ai sign-in, without the refresh token), Pi (only its xAI sign-in and its saved keys, never its Anthropic login), and the logins you made in ADE's provider proxy (without their refresh tokens). For GitHub Copilot, ADE saves the GitHub CLI login only when you turn that on for Copilot. Antigravity's login is saved only after you press Allow. ADE does not copy Muse sign-ins. A login that a tool keeps in the system keychain or keyring stays on the computer, except Antigravity's after Allow. ADE Cloud computers use these logins to run your agents. ADE never copies Claude Code's login to your account; it reads that login only on your computer, to ask Anthropic for your usage limits. Claude on ADE Cloud uses a separate login that you create. You can stop this with “Share my sign-ins with ADE Cloud” in Settings › ADE Cloud, and remove saved logins there.",
          "Passwords & Secrets, API keys for AI providers, and your Linear sign-in. When you sign in, ADE moves these into your account's vault. Secrets you saved before this vault existed were moved in without a question.",
        ],
      },
      "How they are protected: the GitHub and AI tool logins are encrypted on ADE's server with a key that ADE's server holds. Passwords & Secrets are encrypted on your computer, and ADE's key service holds the key that opens them. In both cases a copy of the database alone opens nothing. This is not end-to-end encryption: a person at ADE with access to the server keys could read them. ADE does not do this, but it is technically possible.",
    ],
  },
  {
    id: "smart-decisions",
    title: "Smart decisions (Jev)",
    body: [
      "Smart decisions uses a small AI model to decide things such as whether a chat is waiting for you, whether a status line is out of date, which model fits a new prompt, which command you want in the ⌘K palette, and an emoji for a new lane. It is on by default, also before you sign in.",
      "To decide, ADE sends the model short text from your work:",
      {
        list: [
          "when a chat turn ends: your last message and the agent's reply;",
          "for CLI agents in an ADE terminal, and for any other idle ADE terminal unless you turn off “Also check plain terminals”: up to the last 40 lines on the screen (at most 4,000 characters), with secret-looking values removed;",
          "for the status line: the agent's final reply, your last message (up to 600 characters) and the current status line;",
          "for the model hint: the prompt you are typing, before you send it, the lane name, the number of attached files and images, and one-line summaries of your recent new chats;",
          "for the ⌘K palette: what you typed, the current page and the lane name;",
          "for lane emoji: the lane name.",
        ],
      },
      "This text goes first to OpenCode (opencode.ai) and its free model. If you choose to use your own OpenCode Zen balance, it goes there. When the free daily allowance is used up, ADE's server forwards the same text to TypeSafe (typesafe.ai) with ADE's key. ADE's server does not store or log that text; it records only counts, status and timing. OpenCode and TypeSafe handle it under their own terms.",
      "You can turn Smart decisions off, as a whole or per feature, in Settings › Chat › Smart decisions.",
    ],
  },
  {
    id: "ai-providers",
    title: "AI providers and ADE Cloud computers",
    body: [
      "When you chat with an agent, your prompts, the code and files the agent reads, and tool output go to the AI provider of the model you picked (for example Anthropic, OpenAI, Google, xAI, Cursor or OpenCode), under that provider's terms. ADE does not put this content in product analytics.",
      "If you use ADE's free models without your own provider account, your prompts go to OpenCode's Zen service.",
      "ADE Cloud computers run on servers from Agent 37. Everything in a cloud lane (its code, chats, terminals and the logins it uses) is on that computer. When a cloud lane rests, ADE's server keeps its saved chats, terminal copies, git summaries, queued messages and lane backups. These are encrypted with a key for your account that ADE's server holds. This is encryption at rest, not end-to-end encryption.",
      "ADE watches each cloud computer's CPU use and activity to find mining and other abuse, and to put idle computers to sleep.",
      "ADE Cloud iPhones, where available, run on NoMac's service. On a paid plan, when NoMac has no iPhone free, they run on Revyl's service.",
    ],
  },
  {
    id: "relay",
    title: "The connection relay",
    body: [
      "Your phone, the web app and your other computers reach a computer directly when they can, and through ADE's relay on Cloudflare when they cannot. The relay is not end-to-end encrypted: the connection is encrypted up to the relay, and the relay can read the pairing secrets and the sync traffic that go through it, which includes chats, files and terminal output that you open on another device. End-to-end encryption for the relay is planned work and is not available yet.",
    ],
  },
  {
    id: "analytics",
    title: "Product analytics (PostHog)",
    body: [
      "ADE's desktop app, its background service, ADE on the web and the iPhone app send product analytics to PostHog. It is on by default and the apps have no switch for it. ADE removed the in-app switch in October 2026 (see Changes). The desktop app and the web app still honor an opt-out you recorded in an earlier version. The iPhone app does not. DO_NOT_TRACK=1 stops it on the desktop app and its background service (see Your choices). This website has its own switch, described below.",
      "Events help ADE understand sign-ups, which features people use, reliability and quota health. App analytics never includes prompts, source code, file or terminal content, repository names, file paths, URLs, query strings, referrers, branch names, or session titles. ADE does not use automatic click or page capture. The apps and this website ask PostHog for one setting, whether this session may be recorded, so that ADE's own team is never recorded; no other PostHog feature flags are used.",
      "Identity: desktop events carry a random installation ID and a device ID (see Device identifiers). If you sign in, ADE links that history to a one-way hash of your account ID, and records on that analytics profile your ADE account ID, plan, platform, app version, and whether the install belongs to the ADE team. ADE does not send your email, name or access token to analytics. Signing out starts a new random installation ID, but the device ID stays the same, so events before and after can still be linked to the same computer.",
      "AI usage: for each agent turn, ADE records the AI provider, the model (only for models in ADE's built-in catalog; local and custom models are reported as \"other\"), token counts, estimated cost, how long the turn took, and whether it failed. It never records prompts, responses, tool calls, or system prompts.",
      "Errors: when an app reports an error to Sentry (below), the same error also goes to PostHog with less detail: the error type, its message with credentials, email addresses and file paths removed, and the file names, function names and line numbers of its stack trace.",
      "Session replay: ADE records session replays of the desktop app and the iPhone app: the layout and your taps and clicks. In the desktop app, ADE's own interface text and error messages (menus, tabs, settings labels, notices) are visible, with file paths, email addresses and secrets removed; your content stays masked: code, chats, terminals, files, the names of your projects, lanes and branches, and anything you type are replaced by asterisks. In the iPhone app every piece of text, typed value and label is masked. Images, terminals, code editors and embedded pages are not recorded, and no console output or network traffic is sent. Replays are kept for one month.",
      "PostHog is set to not store IP addresses and to not look up your location. Event collection is deduplicated and capped on your device before it is sent, so a loop cannot send an unbounded stream of events.",
    ],
  },
  {
    id: "errors",
    title: "Error reports (Sentry)",
    body: [
      "ADE's desktop app, background service, web app, servers and iPhone app send error and crash reports to Sentry (United States region). They are on by default and the apps have no switch for them. DO_NOT_TRACK=1 stops them on the desktop app and its background service (see Your choices). The iPhone app does not honor an opt-out stored by an earlier version.",
      "A report can include the error message and stack trace, file paths, the ADE version and build, operating system and hardware details, locale and time zone, the ADE action or screen involved, ADE IDs such as lane and chat session IDs, your device ID and the hash of your account ID, and, for native crashes, a memory snapshot of the crashed process. On the iPhone, a short, fully masked screen recording can come with an error.",
      "Reports from the desktop app and its background service can also attach files: the last 1,000 lines of ADE's log and of the background service's log, recent service logs, and, for an error in the project list, ADE's list of projects with their folder paths. ADE removes credentials, API keys, tokens and secret-looking values from these files. It does not remove anything else: log lines can contain file paths, the arguments of ADE actions and, where a log line has it, parts of chat text. A memory snapshot can, rarely, contain fragments of any data the process held at the time.",
      "Sentry may derive an approximate location from the network address of a report; ADE configures Sentry not to store the address itself. Reports are kept for 30 days.",
    ],
  },
  {
    id: "diagnostics",
    title: "Diagnostic reports",
    body: [
      "When the desktop app or its background service sees certain failures, it sends an automatic diagnostic report to ADE's server, at most three a day from each computer. It does not ask first; a notice tells you after it was sent. You can also send a report yourself with “Report this error to ADE” or Settings › Send a report; then you see the full text before it is sent.",
      "A report is text: what ADE was doing, app and background-service state, recent log lines, the computer's model, memory and running ADE processes, your device ID and a short hash of your account ID. ADE removes credentials and secret-looking values first. Reports are kept in ADE's storage on Cloudflare for up to 30 days. DO_NOT_TRACK=1 stops automatic reports; a report you send yourself is always sent.",
    ],
  },
  {
    id: "usage-report",
    title: "Daily usage report",
    body: [
      "Once a day, each desktop install sends ADE's server a usage report for routing research: the AI provider and model IDs you used, token sums, list-price and billed costs, your plan tier with each provider, quota readings, the local hour of each turn, your time-zone offset, the app version and platform. It never holds an email, account ID, path, lane, chat, prompt or computer name. Its install ID comes from a random value that never leaves your computer, so it cannot be linked to product analytics. Reports are kept for 180 days. It stops with product analytics (DO_NOT_TRACK=1), and ADE_USAGE_RESEARCH=0 stops only this report.",
    ],
  },
  {
    id: "device-ids",
    title: "Device identifiers",
    body: [
      "The desktop app computes a device ID: a SHA-256 hash of your operating system's machine ID (IOPlatformUUID on macOS, MachineGuid on Windows, /etc/machine-id on Linux) and the path of the ADE folder, cut to 16 characters. It stays the same when you reinstall ADE or sign out. It is on product analytics events, error reports, diagnostic reports, and the machine record on your account server (as a separate hash). The raw machine ID never leaves your computer.",
      "The iPhone app's device ID is a hash of Apple's identifier for vendor, which changes if you remove every ADE app from the device. The iPhone app also registers a push notification token with ADE's push service so that it can tell you when an agent needs you.",
    ],
  },
  {
    id: "desktop-extras",
    title: "Other things the desktop app sends",
    body: [
      {
        list: [
          "Weather on the Home page: when the weather widget is shown, ADE asks ipinfo.io for the city of your network address (unless you pick a place yourself) and asks Open-Meteo for the forecast of that place.",
          "Integrations you connect, such as GitHub, Linear, Jira and Apple Music, exchange data with those services as the feature needs. ADE's webhook service receives GitHub events for repositories where you install the ADE GitHub App, and holds them so your computers can pick them up.",
          "Model lists and app updates: ADE checks for new versions on GitHub and reads model lists from provider and catalog services.",
        ],
      },
    ],
  },
  {
    id: "ios",
    title: "The iPhone app",
    body: [
      "The iPhone app (bundle ID com.ade.ios) uses:",
      {
        list: [
          "Your ADE account (above), to sign in and to show your computers and projects.",
          "Camera access, only on the device, to scan a pairing QR code. Frames are not stored or sent.",
          "Local network discovery (Bonjour, _ade-sync._tcp) to find your own ADE computer on the same network.",
          "The microphone and speech recognition, only on the device, to dictate prompts. Audio is not uploaded.",
          "Face ID, only on the device, before it shows or copies a saved password.",
          "Push notifications, through ADE's push service and Apple.",
          "A local database and caches of the projects, files, chats and screens you open, so screens load fast and work offline.",
        ],
      },
      "What you type or attach in a chat goes to the computer that runs the chat, directly or through the relay. For an ADE Cloud chat, that computer is on ADE Cloud, and ADE's server keeps saved chats as described above.",
      "Product analytics, masked session replay and error reports are on by default in the iPhone app. It has no in-app switch, and it ignores an opt-out stored by an earlier version. Analytics never includes source code, files, prompts, pairing data or computer addresses.",
    ],
  },
  {
    id: "website",
    title: "This website",
    body: [
      "Unless you turn website analytics off on this page, the site records a daily visit signal, an allowlisted page category, allowlisted button and feature-demo clicks, coarse browser error categories, and a daily event-budget summary. To understand where visitors come from, each event also carries the page address you are on, the site that linked you here, and any campaign tags (utm_source, utm_medium, utm_campaign, utm_term, utm_content) in the link you followed, plus the first such source this browser arrived from. Each event also carries your browser's user-agent string (browser name and version, and operating system) so that crawlers can be told apart from people. Page addresses keep only the path and campaign tags; other query parameters and fragments are removed, and only the linking site's address without its query is kept. It never sends an error message or stack trace.",
      "With website analytics on, the site also records session replays and heatmaps: the page layout, its public text, and where you click and how far you scroll. Anything you type is masked, all text on the /open and /pair link pages is masked, embedded demos and videos are not recorded, and the /open and /pair pages get no heatmap. Website analytics is on by default; before October 29, 2026 the site asked first.",
      "The site uses a random browser ID in local storage for retention analysis, and keeps the visit's arrival source in session storage and the first arrival source in local storage. Its own analytics events are capped at 40 per UTC day. Requests omit credentials, disable PostHog person profiles and location lookup, and use no analytics cookies. Like any HTTPS service, PostHog and Vercel, which hosts this site, still receive network details needed to answer the request. The site has no advertising pixels; one ran from October 20 to November 17, 2026 (see Changes).",
    ],
  },
  {
    id: "processors",
    title: "Companies that receive data",
    body: [
      "Each company below receives only the data the sections above describe for it.",
      {
        list: [
          "Clerk — sign-in and account profiles.",
          "Stripe — payments and billing.",
          "Resend — ADE's emails.",
          "Cloudflare — ADE's servers, databases and storage, the connection relay, the vault and key service, and diagnostic reports.",
          "PostHog — product analytics, session replay, a copy of error reports, and the operational logs of ADE's servers, in the United States.",
          "Sentry — error and crash reports, in the United States.",
          "OpenCode — Smart decisions and ADE's free models.",
          "TypeSafe — Smart decisions, when the free allowance is used up.",
          "Agent 37 — the servers that run ADE Cloud computers.",
          "NoMac — ADE Cloud iPhones, where available.",
          "Revyl — ADE Cloud iPhones on a paid plan, when NoMac has none free.",
          "Apple — push notifications, Sign in with Apple, and Apple Music when you connect it.",
          "Google and GitHub — sign-in, when you use them to sign in. GitHub also hosts ADE's releases and receives the git and GitHub requests your agents make.",
          "AI providers you use — your prompts and the content your agents send, under each provider's terms.",
          "ipinfo.io and Open-Meteo — the weather widget.",
          "Vercel — hosts this website.",
          "Mintlify — serves the documentation at /docs.",
          "Gravity (IRIS Inc.) — ADE’s ad partner for sponsored cards on the ADE Cloud Free plan, only while they are on; see Sponsored cards below.",
        ],
      },
      "ADE requires PostHog and any other analytics processor to act only for ADE's analytics and not to use ADE analytics for advertising or their own profiling. ADE does not share analytics with advertisers. The only personal data ADE gives an ad partner is what “Sponsored cards on the ADE Cloud Free plan” below describes, and only while those cards are on.",
    ],
  },
  sponsoredSection,
  {
    id: "not-collected",
    title: "What ADE does not collect",
    body: [
      {
        list: [
          "Product analytics never includes prompts, model replies, code, diffs, file contents or terminal output, and no email addresses, names or IP addresses.",
          "ADE never copies Claude Code's own login to your account or to ADE Cloud. It reads that login only on your computer, to ask Anthropic for your usage limits.",
          "Raw hardware IDs never leave your computer; only hashes do.",
          "Session replay never records terminals, code editors, images, embedded pages, console output or network traffic, and masks your content.",
          "Dictation, camera pairing and Face ID on the iPhone stay on the device.",
          "The operational logs that ADE's servers send to PostHog hold no URLs, request bodies, tokens, emails, account IDs or IP addresses. Cloudflare's own logs of ADE's servers, which ADE uses to fix problems, can hold account IDs, computer IDs and error text.",
          "Development builds, tests and CI runs send no analytics and no error reports.",
        ],
      },
      "Because of the items above in Logins, Smart decisions, Error reports and Sponsored cards, ADE does not claim that nothing leaves your computer.",
    ],
  },
  {
    id: "retention",
    title: "Retention",
    body: [
      "PostHog analytics events are kept for no longer than one year, and session replays for one month. Sentry error reports are kept for 30 days. Diagnostic reports are kept for up to 30 days. Daily usage reports are kept for 180 days.",
      "What your account server keeps (sync data, saved logins, ADE Cloud data) is kept while your account exists. Most of it is deleted with the account; the next paragraph lists what stays. A saved login you remove, or a computer or lane you delete, is removed from the account sooner.",
      "Some records stay after you delete your account, so that a new account cannot get the free plan, free hours or referral rewards again, and so that blocks and abuse reports still hold. ADE keeps them under a one-way hash of your account ID in place of the ID, with no end date. They are: the free-plan claim with the hash of your computer; the GitHub claim with your GitHub user ID; the free unlock of a payment card, by the card's fingerprint; blocks, abuse events and alerts to the ADE owner; referral records and earned hours; and the ADE Cloud iPhone sessions, for the cost report. The account record stays marked as deleted. These also stay, under your account ID: the list of computers you signed in to ADE on (each computer's name, platform, network addresses, ADE folder path, a hash of its hardware ID and its device keys), the records of your ADE Cloud computers, and their daily usage, cost, delete and power logs. Ask by email if you want any of these removed.",
      "Desktop analytics state (its installation ID, signed-in identity hash, milestones, hashing salt, preference and quota counters) is stored in the ADE folder's secrets directory until you delete it. Your projects otherwise stay on your disk and are yours to keep, move or delete.",
      "Unpairing the iPhone app clears its saved computer and pairing credentials, but synced data, caches, the analytics ID and quota counters can stay in the app until you remove the app's data. iOS Keychain items can survive an uninstall on some systems, so unpair before you uninstall if you want to clear pairing credentials.",
      "This website stores a browser ID, event-budget counters, the first source this browser arrived from, and your analytics preference. Turning analytics off creates a new browser ID and forgets the first source, but keeps the preference and counters; clearing site data removes them.",
      `To ask what ADE holds about your installation or account, or to ask for earlier deletion, email ${CONTACT_EMAIL}. ADE may need details from your installation or account to find the records. Data sent to AI providers and other companies follows their own retention rules.`,
    ],
  },
  {
    id: "choices",
    title: "Your choices",
    body: [
      {
        list: [
          "Turn off Smart decisions, or single Smart decisions features, in Settings › Chat › Smart decisions.",
          "Stop sharing AI tool logins with ADE Cloud with “Share my sign-ins with ADE Cloud” in Settings › ADE Cloud, and remove saved logins there.",
          "Take your GitHub CLI login off your account in Settings › GitHub.",
          "Turn off sponsored cards on the ADE Cloud Free plan in Settings › ADE Cloud (in the United States, this opts you out of the “sale” or “sharing” of the data they use).",
          "Remove the weather widget from the Home page, or pick a place yourself.",
          "Set DO_NOT_TRACK=1 in the environment ADE runs in to stop product analytics, error reports, automatic diagnostic reports and the daily usage report from the desktop app and its background service. The background service takes DO_NOT_TRACK from the app that installed it, so a service installed before you set it can keep sending until ADE installs the service again. ADE_SENTRY_DISABLED=1 (error reports only) and ADE_USAGE_RESEARCH=0 (the daily usage report only) work for the app you start with them, and do not reach the background service. The iPhone app and the web app have no equivalent setting today.",
          "Revoke camera, microphone or local network access in iOS Settings › ADE.",
          "Delete your ADE account in Account › Delete account.",
          "Turn website analytics off with the control below. You can also call window.adeAnalytics.setEnabled(false) from the browser console.",
        ],
      },
      "DO_NOT_TRACK does not stop the features in Logins, Smart decisions or sync, because they are part of how ADE works; use their own controls above.",
    ],
    analyticsControl: true,
  },
  {
    id: "children",
    title: "Children",
    body: [
      "ADE is a developer tool and is not directed at children under 13. ADE does not knowingly collect personal information from children.",
    ],
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: [
      "When ADE makes a material change, it updates this page and the date at the top, adds an entry below, and shows a one-time notice in the desktop app, ADE on the web and the iPhone app. If you keep using ADE after a change, you accept the changed policy.",
      {
        list: [
          "November 25, 2026 — Sponsored cards on the ADE Cloud Free plan: in the United States, except California, the cards start on and you can turn them off; in California ADE asks first. The section also covers Global Privacy Control, turning the cards back on in two steps, and the free Small computers the cards pay for.",
          "November 24, 2026 — Added “Sponsored cards on the ADE Cloud Free plan”: Gravity is ADE’s ad partner, and that section lists what it receives.",
          "November 24, 2026 — Rewrote this policy to list everything ADE collects, without changing what ADE collects. Added: copying of GitHub CLI and AI tool logins to your account, the vaults and how they are encrypted, the sync data the account server keeps, Smart decisions and the text it sends to OpenCode and TypeSafe, the log lines attached to error reports, automatic diagnostic reports, the daily usage report, the device ID, the relay not being end-to-end encrypted, ADE Cloud data, the weather widget, and the full list of companies. Corrected earlier statements that were wrong: that prompts stay on your computer by default, that error reports do not include chat text, that diagnostic logs are shared only when you choose, that analytics starts with only a random installation ID, that the iPhone app honors an earlier opt-out, and that turning analytics off is possible in the apps.",
          "November 17, 2026 — Removed the Freebuff advertising pixel from this website, and its entry in this policy.",
          "November 14, 2026 — Passwords & Secrets became one vault in your account, on by default; secrets saved before were moved in without a question. This policy did not say so until November 24.",
          "November 12, 2026 — ADE started copying the GitHub CLI login to your account, and the account started to keep the list of your projects with their folder paths. This policy did not say so until November 24.",
          "November 10, 2026 — ADE started copying AI tool logins to your account for ADE Cloud. This policy did not say so until November 24.",
          "October 29, 2026 — Website analytics became on by default, with the switch on this page. Before, the site asked first.",
          "October 21, 2026 — Smart decisions (Jev) started, on by default. This policy did not say so until November 24.",
          "October 20, 2026 — Added the Freebuff advertising pixel to this website, with an entry in this policy. It recorded visits, kept the click ID from a Freebuff ad link, and reported download and install-copy clicks. It was removed on November 17.",
          "October 14, 2026 — The iPhone app stopped honoring an analytics opt-out stored by an earlier version.",
          "October 13, 2026 — ADE removed the in-app switches for product analytics and automatic diagnostic reports from the desktop app, and the analytics prompt and switch from the iPhone app, and started Sentry error reports on every surface. This policy then said to use DO_NOT_TRACK=1 instead of the switches.",
        ],
      },
    ],
  },
  {
    id: "contact",
    title: "Contact",
    body: [
      `Questions about privacy or data handling: ${CONTACT_EMAIL}.`,
    ],
  },
];

function AnalyticsPreferenceControl() {
  const [enabled, setEnabled] = useState(() => isMarketingAnalyticsEnabled());

  useEffect(() => onMarketingAnalyticsPreferenceChange(setEnabled), []);

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border/70 bg-bg/50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-semibold text-fg">Website analytics</div>
        <div className="mt-1 text-xs text-muted-fg">
          {enabled ? "On — allowlisted, capped events, session replay and heatmaps are sent." : "Off — no website analytics events are sent."}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className="focus-ring inline-flex min-w-36 items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-fg hover:bg-muted/70"
        onClick={() => setMarketingAnalyticsEnabled(!enabled)}
      >
        Turn analytics {enabled ? "off" : "on"}
      </button>
    </div>
  );
}

export function PrivacyPage() {
  useDocumentTitle("ADE Privacy");

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Privacy</h1>
            <p className="mt-3 text-sm text-muted-fg">
              Last updated {LAST_UPDATED} ·{" "}
              <a className="focus-ring rounded-md text-fg underline underline-offset-2" href="#changes">
                What changed
              </a>
            </p>
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-fg">
              This page explains what data ADE collects, where it goes, how long it is kept, and the choices you have.
              It covers the desktop app, its background service, ADE on the web, ADE Cloud, the iPhone app, the ADE
              command line and this website.
            </p>
          </Reveal>

          {/* Some sections are taller than four phone screens, so any visible part reveals one. */}
          <div className="mt-10 grid gap-6">
            {sections.map((section, index) => (
              <Reveal key={section.id} delay={Math.min(index * 0.04, 0.2)} amount="some">
                <div id={section.id} className="scroll-mt-24 rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                  <h2 className="text-sm font-semibold text-fg">{section.title}</h2>
                  <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-fg">
                    {section.body.map((block, i) =>
                      typeof block === "string" ? (
                        <p key={i}>{block}</p>
                      ) : (
                        <ul key={i} className="list-disc space-y-1.5 pl-5">
                          {block.list.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )
                    )}
                    {section.analyticsControl ? <AnalyticsPreferenceControl /> : null}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>
    </Page>
  );
}
