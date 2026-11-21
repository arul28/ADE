# Pricing v2 and Gravity: free Small computers, paid for by ads

The owner decided this plan between 2026-11-19 and 2026-11-21. It is the base
every lane in this work builds from. Today's plan rules are in
[ade-cloud-plans-and-disk.md](./ade-cloud-plans-and-disk.md) and
`apps/account-directory/src/cloud/plans.ts`; this plan replaces their numbers
and keeps their principles. Nobody pays yet, so there is no migration.

Everything here is account-wide, so it follows **Account-wide features live
on the account server** in `AGENTS.md`: the server decides, counts and holds
the keys; desktop, CLI, web and phone read the answer and show it.

## The offer in one sentence

> Unlimited Small computers. They never use your hours. Bigger computers use
> hours, and each plan has a number of cloud computers.

## Plans

| | Free | Plus $5 | Pro $20 | Max $50 |
|---|---|---|---|---|
| Cloud computers (asleep or not) | 2 | 3 | 10 | 20 |
| Small computers | Unlimited | Unlimited | Unlimited | Unlimited |
| Hours for bigger computers | 50 | 100 | 600 | 1,500 |
| Extra hours | none | 2¢ each | 2¢ each | 2¢ each |
| Ads | Ad-supported | none | none | none |
| Outside agents (ADE MCP) may use ADE Cloud | no | yes | yes | yes |

- **One hour = one Medium hour.** Medium uses 1 hour an hour, Large 2.5,
  X-Large 4. The four unlisted shapes use hours in proportion to their cost
  against Medium. Small uses none.
- **Show hours as time on each size**, never as a multiplier: "50 hours on a
  Medium · 20 on a Large".
- **Never say "0 hours".** Say "Unlimited Small computers. They never use your
  hours." A fair-use line in the small print lets the owner act on a rare
  outlier.
- **No GB on any surface.** Each size keeps its own disk maximum (Small 12 GB)
  and idle cleanup stays as it is; those two are the disk backstop. Disk shows
  only when one computer's disk is nearly full.
- **Automations and webhooks** run on every plan with no special rule.
- **Outside agents on Free** are refused at the server with a sentence the
  agent passes on: "ADE Cloud can't be started by outside agents on the Free
  plan. To let outside agents use ADE Cloud, move to a paid plan."
- **Free plan gate** stays as today: a GitHub account at least 30 days old or
  a $0 card, plus one free plan per computer. Move to card-only only if
  farming shows up in the `signup_burst` and cost alarms.

### At the computer limit

One card, three ways out:

> **You're using all 2 of your cloud computers.**
> - Free up a computer from another lane. The lane and its chats stay; it
>   gets a new computer the next time you send a message there.
> - Delete a lane.
> - Move to Plus for 3 computers.

A lane without a computer already looks like an asleep lane (#2435), so the
first option is safe.

### Why the numbers hold (Agent 37 prices, 2026-11)

| Size | Cost an hour awake |
|---|---|
| Small (2 CPU, 4 GB) | 0.6¢ |
| Medium (4, 8) | 1.2¢ |
| Large (full 4, 8) | 3.0¢ |
| X-Large (full 4, 16) | 4.9¢ |
| Disk, asleep too | $0.09 per GB a month |

A heavy user (every computer awake 4 hours a day, every hour used) costs about
$2 on Free, $3.40 on Plus, $14.40 on Pro and $32 on Max, against about $0,
$4.38, $18.42 and $46.50 kept after Stripe and Managed Payments fees. None of
this counts ad or Index income. Computers sleep 3 minutes after work stops and
ADE allows no public ports, so a free Small can't host a 24/7 service.

## Gravity (trygravity.com)

The account is approved (self-serve, 1,000 requests a day, Index on, Stripe
payouts connected). The key is `GRAVITY_API_KEY` in ADE secrets and becomes a
Worker secret; no app ever ships it. A partner agreement (no daily limit)
comes before launch.

| Product | In ADE | Who sees it | Paid on |
|---|---|---|---|
| **Sponsored cards** | One card under a finished reply | Free plan cloud chats; every ADE Free Models chat | Views and clicks |
| **Index** | An ADE tool agents call when the person needs a service; a labeled recommendation card | Free plan cloud chats | Confirmed sign-ups |
| **Inference** | ADE Free Models (below) | Anyone who picks it | Gravity pays the model cost from the ads |

Rules for every product:
- **Calls go through the account server only**, with the end user's IP and
  user agent forwarded and `device_type`/`os` set (required from 2026-12-01).
- **Ask for an ad only when a person has that chat open**, and load its
  `impUrl` only when at least half the card is on screen. Anything else is
  invalid traffic and ends the account.
- **One Gravity ad on screen at a time, and no ADE upgrade nudge beside it.**
- **No ads in:** CLI terminals, subagent views, Work list previews,
  notifications, chats on a person's own subscription, local-only or company
  accounts, and paid plans.
- **Never reward a view or a click.** Free is ad-supported as a plan; nothing
  is earned per ad.
- **The Index is called only for a real need** the person has, its pick is
  labeled Sponsored, and nothing installs without the person's tap. In a CLI
  session the label goes in the agent's own reply.

### ADE Free Models

Gravity's hosted models (DeepSeek V4.1 Flash, GLM 5.3 Flash), shown on the
model picker's Free page with an **Ad-supported** badge. Waiting on Gravity to
enable inference and a `gr_inf_` key.

- Open to anyone. The first use opens a one-time consent sheet, stored on the
  account server: Sponsored cards in these chats, and what Gravity receives
  (recent messages, IP, a hashed email; Gravity keeps a license to what is
  sent).
- Runs through OpenCode against an OpenAI-compatible endpoint on the account
  server, which adds the key, `session_id`, `email_hash` and `user_ip`.
- **Chat only.** Hidden in CLI sessions (ADE can't draw a card there) and
  outside the US and Canada (Gravity refuses them).

## Cloud iPhone: one switch plus testers

The Cloud iPhone waits for a more reliable provider and real prices.

- `CLOUD_PHONE_ACCESS` stays the one switch: `off`, `beta` (testers only) or
  `all`.
- In `beta`, a person not on the list sees nothing: no plan line, toolbar
  button, pane, website mention or agent path. Today they see "soon"; that
  changes to hidden.
- The owner adds testers **by email**, before or after they sign up; the
  match happens at sign-in.
- The website shows the Cloud iPhone only at `all`.
- Its price in hours is set when it returns.

## Work, in order

| # | Piece | Depends on |
|---|---|---|
| 1 | Free page in the model picker (lane `ade/free-model-access-feedback`), rows that can carry a badge | in progress |
| 2 | **Pricing v2:** server plan rules (Small free, computers per plan, new hour unit, outside-agent refusal on Free, iPhone hidden and email testers), live Stripe prices, then every surface: website pricing and home, desktop ADE Cloud pages and settings, phone, `ade cloud status`, emails, feature docs. Every surface reads the server catalog. Live Stripe changes need the owner's OK. | this plan |
| 3 | **Gravity foundation** on the account server: one module, Worker secrets, consent record, plan and country checks, ad, Index and model endpoints, kill switch, owner report of cost against ad and Index income | none; test ads work today |
| 4 | Sponsored cards on desktop, web and phone | 2, 3 |
| 5 | Index for agents | 3 |
| 6 | ADE Free Models | 1, 3, inference key |
| 7 | Go-live: register placements, review with Gravity (they want a test login), turn off test mode | 4, 5, 6 |

## Before launch

- Privacy policy and Terms on the website: what Gravity receives and keeps,
  an 18+ line (Gravity requires it), fair use.
- App Store: App Privacy labels and, if needed, the tracking prompt, before
  the phone shows a card.
- A written yes from Gravity that an ad-supported free plan of cloud
  computers is fine (it matches their own best practices).
- A partner agreement to lift the 1,000-requests-a-day limit.
