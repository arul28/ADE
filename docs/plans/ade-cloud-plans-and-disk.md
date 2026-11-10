# ADE Cloud: plans, tiers, disk and cost protection

Decided with the owner on 2026-11-10. This replaces the plan, size and disk
rules in `ade-cloud-2-spec.md` where the two differ. Users never see the
provider's name.

## Principles

- A person thinks about one thing: how fast a computer uses hours.
- Nobody manages disk. It grows by itself when the work needs it.
- A limit is on what exists at one time, never on what a person makes in a
  month. Delete a computer and its disk and its place are free again.
- No feature wall on the free plan. Free hours can be spent on any tier.
- Anything that raises what a person pays asks first, once, with the price.
- The owner can always see cost against income, and can cap the total.

## Provider cost (public docs, read 2026-11-10)

vCPU $0.80, memory $0.70 per GB, disk $0.09 per reserved GB, each per month.
CPU and memory bill only while awake; a full computer (vm) bills them at 2.5x.
Disk bills always, asleep too. Cold storage ($0.03 per compressed GB) happens
only when the provider's host needs the space, so never count on it. A disk
only grows; a grow or a resize restarts the computer. Disk limits by shape:
standard 2/4 to 12 GB, 4/8 to 20, 4/16 to 40, 4/32 to 80; full to 100.

## Tiers (the main list)

| Tier | Type, CPU / memory | Can do | Disk grows to | Rate | Cost per hour |
|---|---|---|---|---|---|
| Small | standard 2 / 4 | code, tests, browser, Linux screen | 12 GB | 1x | 0.6 c |
| Medium | standard 4 / 8 | larger builds | 20 GB | 2x | 1.2 c |
| Large | full 4 / 8 | adds Android and Docker | 50 GB | 5x | 3.0 c |
| X-Large | full 4 / 16 | heavy Android and Docker | 100 GB | 8x | 4.9 c |

The other four sizes stay valid on the server for computers that exist and
for an advanced choice; they are not in the main list. Every computer starts
at 4 GB.

## Plans

| | Free | Plus, $5 | Pro, $20 |
|---|---|---|---|
| Hours each month | 50 | 500 | 1,500 |
| Disk at one time (whole account) | 12 GB | 40 GB | 120 GB |
| Computers at one time | 3 | 10 | 30 |
| Every tier, Android, Docker | yes | yes | yes |
| Extra hours | no | 1 c (0.85 c after 1,000) | same |
| Extra disk | no | $1 per 10 GB per month | same |

- Free disk is one shared 12 GB, not 4 GB for each computer. Android on the
  free plan works when the account has the room.
- Extra hours and extra disk are off until the person turns them on, as extra
  hours are today.
- Extra disk is counted by the day, on the GB above the plan's disk. It stops
  the day the disk is gone. It never runs to the end of a month.
- Extra use is charged after use: each time the open amount reaches $5, and
  the rest on the billing date.

## Disk growth

- Inside the plan's disk and the tier's limit: automatic, no question. ADE
  says so afterwards.
- The first growth into paid disk asks once, with the price and a cleanup
  option. After that a monthly limit the person sets lets it continue.
- With extra disk off, or on the free plan, the answer is a plain sentence
  that names the two ways out: delete a computer, or a bigger plan.
- A grow happens at an idle moment, or on a step the person asked for
  (starting Android), because it restarts the computer.

## Cost protection for the owner

- Daily report: provider cost and income for each account, with margin.
- Alarms: an account that costs more than it pays; a day whose total cost
  jumps; the existing low-wallet and instance-limit alarms stay.
- A hard limit the owner sets. At that total, no new computer and no disk
  growth until the owner raises it. Wakes of existing computers still work.
- Product analytics for create, wake, sleep, grow, move, tier change, delete,
  plan change and each refusal, inside the rules of `docs/logging.md`.
- Error tracking on every failed provider call and every billing mismatch.

## Not in this document

The tier and disk screen, the cleanup list, the approval card for a tier
change, and lanes without Primary belong to Cloud 3.
