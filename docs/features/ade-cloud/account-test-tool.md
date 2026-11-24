# Account test tool and instant switches

One owner-only tool for testing ADE Cloud as any plan, and for flipping the
server switches without a deploy. Every change takes effect on the account's
next read (a few seconds in the apps). Nothing here touches Stripe.

- Script: `scripts/cloud-owner.mjs`
- Routes: `POST /cloud/owner/account`, `POST /cloud/owner/settings`
  (`apps/account-directory/src/cloud/ownerAccounts.ts`)
- Switches: `apps/account-directory/src/cloud/settings.ts`
- Storage: `cloud_accounts.test_*`, `cloud_settings`, `cloud_owner_log`
  (migration 0056)

## Who can use it

Anyone holding `CLOUD_OWNER_TOKEN`: the owner, and agents through ADE's
secrets. Agents never print the token:

```bash
ade secrets exec --env CLOUD_OWNER_TOKEN -- node scripts/cloud-owner.mjs show you@example.com
```

An account's own sign-in never reaches these routes. Every change is written
to `cloud_owner_log` and shown by `show`.

## Accounts

Name an account by its verified email or its Clerk user id (`user_…`).

| Command | What it does |
|---|---|
| `show <account>` | The real plan, the test, what is in force now, and the last changes |
| `act-as <account> free\|plus\|pro\|max` | The account acts as that plan: computer limit, hours, outside agents, sponsored cards, Small's hours |
| `limits <account> --computers N --hours N --phone-minutes N` | Its own computer limit, monthly hours and ADE Cloud iPhone minutes this period, on top of the plan (`limits <account>` with no options clears all three) |
| `phone <account> on\|off` | On the ADE Cloud iPhone's beta list, or off it. Not a test: it stays until changed. While `CLOUD_PHONE_ACCESS` is `beta`, `off` stops a running phone (under `all`, the list doesn't decide access). A tester picks their own phones' provider (`auto`, NoMac or Revyl) in an ADE beta build or with `ade cloud phone-provider`; the owner no longer sets it |
| `tester <account> on\|off` | On or off the sponsored testers list |
| `ad-format <account> below_reply\|above_prompt\|inline\|switch` | Where this account's sponsored cards show: under the reply, docked above the prompt box, or one linked sentence at the end of the reply (`switch`: whatever `gravity_format` says). Not a test: it stays until changed |
| `ab [--days N]` | The format A/B scoreboard (default 14 days): per format its weight, accounts held to it, how many said yes or no, cards asked and filled, hides per card, and Gravity's views, clicks, CTR and revenue for that format's placements |
| `reset <account>` | Back to the real plan |

`act-as` and `limits` take `--days N` (default 7, at most 90) and
`--note "why"`. A test ends by itself when its days are up; the minute tick
clears it. The testers list has no end date: take an account off it with
`tester <account> off`.

A userId names an account ADE Cloud already has (a typo is refused); an email
Clerk verified may be one that never used ADE Cloud, which then starts on
Free.

### What a test changes, and what it never does

A test changes what the account may do and what it sees: the plan name, the
computer limit, the hours meter and when it stops, sponsored cards, Small's
hours, and the outside-agent rule. Billing keeps the real plan: the Stripe
subscription, its charges, extra hours, the period and its renewal. So the
owner's Pro account can act as Free for a week and keep paying for Pro, and a
Free account acting as Max is never charged for Max.

Things that still follow the real plan: idle cleanup's timing, plan cleanup
after a real downgrade (it waits while a test of the plan, computers or hours
runs), and the iPhone's minutes unless `--phone-minutes` sets them (`act-as`
alone leaves them the real plan's). Test iPhone minutes are the whole limit:
no extra minutes run past them, and a running phone is held to new minutes at
once (set, cleared, reset, or the test's end).

Billing counts the real plan's hours, so a test may not give more hours than
that to an account with earned hours or extra hours on: those would be used
for real. The tool refuses it (409); test fewer hours, or use another account.
For the same reason it refuses test iPhone minutes on an account with extra
iPhone minutes on: those bill past the real plan's minutes. Turning extra
minutes on is refused (409) while test iPhone minutes are set.

## Switches

| Key | Values | Deploy ceiling | What it does |
|---|---|---|---|
| `gravity_ads` | `off`, `testers`, `all` | `GRAVITY_ADS` | Sponsored cards, the Index and the Free rule: nobody, the testers list, or every Free account |
| `gravity_live` | `off`, `on` | `GRAVITY_LIVE=1` | Real ads instead of Gravity's free test ads |
| `gravity_format` | `below_reply`, `above_prompt`, `inline`, `split` | none | Where cards show for every account; `split` holds each account to one of the three by its id (the same on every machine). An account set with `ad-format` keeps its own |
| `gravity_format_split` | `70-20-10`, `80-15-5`, `60-25-15`, `50-30-20`, `34-33-33` | none | Under `split`, the share of new accounts for under the reply, inline and above the prompt box, in that order. An account keeps the format it was first given (`cloud_sponsored_formats`), so a change moves only accounts ads reach for the first time |
| `cloud_credits` | `off`, `testers`, `all` | `CLOUD_CREDITS` | Credits: hours become credits on every surface and the ADE Cloud iPhone draws from them at one a minute. `testers` is the iPhone beta list. See [Credits](README.md#credits) |

```bash
node scripts/cloud-owner.mjs settings
node scripts/cloud-owner.mjs set gravity_ads testers --note "ads test on the owner's account"
```

A switch with no row reads `off`. A deploy variable is the highest its switch
may go: `GRAVITY_ADS=off` in `wrangler.jsonc` is a hard off whatever the switch
says. Turning ads on (which also turns on the Free rule) or real ads for real
users is the owner's call, asked for each time.

### The Free rule

The Free rule is part of the ad switch. A Free account (or one acting as Free)
that the ad switch reaches runs Small computers without hours only while it
said yes to sponsored cards. A no, or no answer yet (outside the card
countries, or never asked), has Small use half a Medium-hour an hour. Accounts
the ad switch doesn't reach are untouched, so with `gravity_ads=testers` only
the testers see the rule. A no is asked again two weeks later
(`SPONSORED_REASK_MS`), and at once when it came before the ad switch last
changed; until the person answers, it still counts as a no. A yes from outside the card countries is refused (403): there are
no cards to show there, so Small keeps using hours.

### Countries

Cards go only to viewers in `GRAVITY_COUNTRIES` (default `US,CA,GB,AU`, where Gravity fills real ads), read from
Cloudflare's `cf.country` for the viewer's own connection; where the ADE Cloud
computer runs does not matter. While ads are test ads (`gravity_live` off), an
account on the testers list skips that check for cards, so the owner can test
from anywhere. Real ads keep it for everyone, and so does the Index: it has no
test mode, so a tester abroad gets no Index picks.

Small's rate is changed on the computer's row (the time so far is charged at
the old rate), at once after a yes or no, a test change or a switch flip, and
by every minute tick for any account still on the wrong rate (a deploy
variable's hard off, or what a flip's 20 seconds didn't reach).

While it is on, the hours emails and the out-of-hours message stop saying
Small keeps working to an account whose Small uses hours.

## Testing ads end to end

1. `tester <you> on`, then `act-as <you> free` (a paid account sees no cards).
2. `set gravity_ads testers`.
3. Open a chat on one of your ADE Cloud computers, finish a reply, answer the
   one-time question. Gravity's test ads say "Sponsored · test".
4. Optional: answer no to see Small use hours (the Free rule).
5. When done: `reset <you>`, `tester <you> off`, and `set gravity_ads off`
   unless the owner wants it left on.
