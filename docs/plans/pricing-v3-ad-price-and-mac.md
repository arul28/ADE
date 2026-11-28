# Pricing v3: the ad price, new credit numbers, and the cloud Mac

The owner decided this plan on 2026-11-27 and 2026-11-28. It builds on
Pricing v2 (shipped; the plans, credits and sponsored ads it made are in the
DAEX Cloud guide, [`docs/features/ade-cloud/README.md`](../features/ade-cloud/README.md)).
It replaces that plan's numbers and its rule "no ads on paid plans", and it
keeps everything else.

Everything here ships behind two server settings that start at `off`:
`pricing_v3` (`off`, `testers`, `all`) and `mac_computers` (`off`,
`testers`, `all`, with its own testers by email). At `off`, every answer,
number and screen is the same as before, for old and new app versions.

Everything here is account-wide, so it follows **Account-wide features live
on the account server** in `AGENTS.md`: the server decides, counts and
refuses, and every app shows the answer.

Two words used in this plan:

- **Full price:** the price with no ads.
- **Ad price:** the lower price while ads show.

## The offer in one sentence

> With ads on, DAEX Cloud costs 20% less. Turn ads off at any time.

## Credits

One credit is 6 minutes of a Medium computer. Every number is 10 times the
Pricing v2 number, so the money and the hours of each plan stay the same. The
scale is 10 because it is the smallest one where 20% off gives a whole number
for every product.

| Product | Full price | Ad price |
|---|---|---|
| Small, Free plan | 5 an hour | Free |
| Small, paid plans | Free | Free |
| Medium | 10 an hour | 8 an hour |
| Large | 25 an hour | 20 an hour |
| X-Large | 40 an hour | 32 an hour |
| Mac | 5 a minute | 4 a minute |
| iPhone | 5 a minute | 4 a minute |

| | Free | Plus $5 | Pro $20 | Max $50 |
|---|---|---|---|---|
| Credits a month | 500 | 1,000 | 6,000 | 20,000 |
| Cloud computers (a Mac counts as one) | 2 | 3 | 10 | 20 |
| Extra credits | none | $4 for 1,000 | $4 for 1,000 | $4 for 1,000 |

- **The iPhone costs half of its Pricing v2 price.** Nothing else changes in
  money.
- **The discount is one server setting** (`ad_discount_pct`, 20 at the start,
  0 to 50 in steps of 5; at 0 no app shows a second price).
  The owner reads the ad income each month and changes it when the data says
  so.
- **The four unlisted Linux shapes** keep their rate in proportion to Medium,
  rounded down to a whole credit at both prices, so nobody pays more than
  before. Every ad price is the full price less the discount, rounded down to
  a whole credit.
- **Small on Free costs 5 an hour at the full price only while ads reach
  everyone** (the server's ad switch at `all`). While they don't, Free's Small
  is free, as before. It is free with ads at any discount.
- **Storage stays as it is.** The server keeps milli-credits. Only the scale
  that apps show changes, and the catalog carries it, so an app never
  multiplies by itself.

## When a computer has the ad price

The bill is for each computer, so the price belongs to the computer. A
computer has the ad price for a minute when all of these are true:

1. Ads are on for the account, and the person is in a country with ads.
2. A chat on that computer was in use in the last 60 minutes (`ad_window_minutes`).
3. No full-price work runs on that computer.

**"In use" means one of two events from a DAEX app:**

- A person sends a message in a chat on that computer.
- A reply finishes and the app asks for an ad. The request counts even when
  there is no ad to show.

Each event starts the 60 minutes again. A long turn with no finished reply
goes back to the full price after 60 minutes, and the next finished reply
brings the ad price back.

A message in a chat that has no saved copy on that computer yet (a first
message) holds the ad price for 10 minutes, not the whole window, and counts
at most 6 times a day for a computer (12 for an iPhone session). A saved chat
gets the whole window. One message counts one time.

**A person's message is its computer's proof before anything else.** A new
lane's first message counts at the create, so a Small on Free with ads on is
made at 0 credits, and a new computer has the ad price from its first minute.
A message that wakes a resting computer counts before the wake's credit check.
A wake or a create with no person's message (an outside agent, an automation)
gets no such proof.

**Full-price work** is work where DAEX cannot show an ad:

- An agent CLI session (`claude`, `codex` and the others) in a terminal.
- An automation, a webhook run or a scheduled run.
- A lane or a chat that an outside agent started through DAEX MCP.

While one of these runs on a computer, the whole computer has the full price.
A notice says so when a CLI session starts and when a person sets up an
automation.

As built: the computer's brain reports the CLI sessions and automation runs
it starts, on change. An agent CLI a person types by hand in a plain terminal
is detected for Claude, Codex, Cursor, Droid, OpenCode and Muse, not yet for
the others. An outside agent's message through the account server holds the
full price until the computer reports idle after the turn it began (30
minutes if it never reports busy); an outside agent with a direct link to the
computer's brain is not detected.

**Things that do not change the price:**

- A helper agent (subagent) follows the chat that started it.
- A plain terminal, a dev server or a preview.
- A person who watches the screen of the computer.

**Smaller rules:**

- The proof syncs: desktop, web and phone send it to the account server. One
  reply counts one time, on any number of devices.
- If a person turns ads off, the full price starts at the next minute.
- The server reads the country from each request. A person who travels to a
  country with no ads has the full price there.
- On a shared lane, only the account that pays for the computer can give the
  proof.
- An old app version sends no proof, so it has the full price. Old apps are
  told apart by a request header that every new app sends. On Free, an old
  app keeps today's ads and today's free Small; on a paid plan, an old app
  shows no ads.
- A cloud iPhone started before Pricing v3 reached the account keeps the rate
  it started with until its session ends.

### Requests that do not count

An ad request that comes from the network of the account's own cloud computer
(its own network, or one it joined from in the last 30 days) is not a person
at a screen. The server does not count it, does not send it to
Gravity, and alerts the owner. There is no ban and no penalty: that computer
has the full price for that time, and the price row says so in one line. The
owner reviews the alerts after one month. A request from DAEX Cloud's network
that is none of the account's own computers (a VPN there) counts, with an
owner alert only.

## Who sees ads

| Region | Ads at the start | The first chat says |
|---|---|---|
| US, not California | On, every plan | Ads are on, so DAEX Cloud costs 20% less. One click turns them off. |
| California, Canada, UK, Australia | Off | Turn on ads to pay 20% less. |
| Every other country | No ads | Nothing. Only the full prices show. |

- **The notice always comes before the first ad,** on every plan. A person who
  pays for a plan never sees an ad before the notice.
- **Turning ads off is one click,** in the notice and in the price row.
- **Free's Small is free with ads in all four ad countries.**
- **Small stays free with no ads on paid plans,** as in Pricing v2.

### Where ads show

One rule: **a chat shows ads while it uses something DAEX Cloud pays for.**
That is a cloud computer, a cloud Mac, a cloud iPhone or an DAEX Free Model.

- A chat on the person's own computer that uses nothing from DAEX Cloud never
  shows ads.
- One finished reply has one ad position and one ad request, whatever the
  chat uses.
- Never in CLI terminals, subagent views, Work list previews or notifications.

### The switches

- **Ads:** one switch for the account, for Linux, Mac and iPhone. There is no
  switch for each product and no second switch.
- **DAEX Free Models:** its own switch, for the feature. Its text says the
  models are free because they show ads. It is not the ad switch.

A person learns the whole deal from three places, each with one sentence:

1. **The first chat:** "Ads are on, so DAEX Cloud costs 20% less." with
   "Keep ads" and "Turn off ads". On Free it names the Small: "Ads are on:
   Small computers are free, and bigger ones cost 20% less."
2. **Every price:** the price now, and the other price beside it.
3. **Settings:** the one switch, with the same sentence as the first chat.

When a computer has the full price while ads are on, the price row gives the
reason in one line, for example "Full price: a CLI session runs here".

### DAEX Free Models and a cloud computer

- The ad of a free-model chat counts for the Free Models rules and as the
  proof for the cloud computer.
- If DAEX Free Models is on and the ad switch is off, the ad still shows in
  that chat, because the model needs it. The computer has the ad price for
  that time: the price follows the ad that shows.

## Words

- Say "with ads" and "no ads", and "ad-supported pricing".
- Never say "earn", "reward" or "watch ads to save".
- Only two things decide the ad price: ads are on, and a chat is in use. The
  number of ads, views and clicks never changes a price, and no counter of
  ads seen exists.

## What people see

- **Every place that shows a price** shows both: the size menu, the composer,
  Settings, the pricing page, the phone and `daex cloud status`. Example:
  "10 credits an hour · 8 with ads".
- **The website** has a "With ads / No ads" control on the pricing section,
  like monthly and yearly. With ads, the full price shows crossed out beside
  the ad price.
- **A person in a country with no ads** sees no control, no second price and
  nothing about ads.
- **CLI sessions and automations** show only the full price, with the notice.

## The cloud Mac

A Mac is a cloud computer of a second kind, from NoMac. The person picks
DAEX Cloud, then Linux or Mac. A Mac has one size.

| | Linux | Mac |
|---|---|---|
| Sizes | Four | One: 6 CPU, 8 GB |
| When work stops | Sleeps after 3 minutes, keeps its disk | Stops after 5 minutes, keeps only its 20 GB drive |
| Start | Wakes | A new Mac in 20 to 45 seconds, with the same drive |
| Unused lane cleanup | 3 days Free, 10 days paid | The same |

- **Every plan can use a Mac,** Free too.
- **A Mac lane counts as one of the plan's cloud computers.**
- **The switch** is `mac_computers`: `off`, `testers` or `all`, with a list of
  testers by email. At `off` and for a person not on the list, nothing about
  the Mac shows.
- **When no Mac is free,** the lane waits in a queue and says so.
- A first drive is a copy of a template that holds no secrets.

## Why the numbers hold

| Product | Cost to DAEX an hour | Full price at $4 for 1,000 |
|---|---|---|
| Small | 0.6¢ | 2¢ |
| Medium | 1.2¢ | 4¢ |
| Large | 3.0¢ | 10¢ |
| X-Large | 4.9¢ | 16¢ |
| Mac, iPhone | 60¢ | $1.20 |

- The Mac and the iPhone are thin. The one case with a loss is a Max account
  that has ads on and spends every credit on a Mac or an iPhone: about $3.50
  a month before ad income.
- A Free account that spends every credit on a Mac costs about $1.25 a month.

## Work, in order

| # | Piece | Depends on |
|---|---|---|
| 1 | **The proof signal and DAEX Free Models** (branch `ade/gravity-free-models-inference`): the ad request after a finished reply, the Free Models switch as a feature switch, one ad that counts for both | none |
| 2 | **The ad price on the server:** the proof for each computer, the 60-minute rule, full-price work, requests that do not count, ads on every plan, the notice state, the catalog with both prices and the credit scale, the two settings | 1 |
| 3 | **Every surface:** both prices, the first-chat notice, the off control, the switches, the new credit numbers. Desktop and web; phone; `daex cloud status`; emails; feature docs | 2 |
| 4 | **The website:** new numbers and the "With ads / No ads" control | 2 |
| 5 | **The iPhone:** 5 credits a minute, the ad price through the chat that holds it | 2 |
| 6 | **The cloud Mac:** the second provider on the server, the Mac image and template drive, the Linux or Mac pick, the queue, the tester switch | none for the build; 2 for its ad price |

Pieces 3, 4 and 5 run at the same time. Piece 6 runs beside all of them.

## Before launch

- Privacy policy and Terms: ads on paid plans, and the ad price as a choice.
- California: the notice of the offer, the opt-in, and the way to withdraw.
- App Store privacy labels, for ads in every plan's chats on the phone.
- Remove "no ads on paid plans" from every surface.
