# ADE Cloud: plan, disk and cost rules

The owner decided these rules. Code comments point here for the reasons
behind them. The current numbers (plans, hours, disk, sizes, prices) live in
`apps/account-directory/src/cloud/plans.ts`, and
[docs/features/ade-cloud/README.md](../features/ade-cloud/README.md)
("Plans, hours and sizes") shows them. Users never see the provider's name.

**Next:** [pricing-v2-and-gravity.md](./pricing-v2-and-gravity.md) replaces
these numbers (free Small computers, computers per plan, no GB shown) and
keeps the principles below.

## Principles

- A person thinks about one thing: how fast a computer uses hours.
- Nobody manages disk. It grows by itself when the work needs it.
- A limit is on what exists at one time, never on what a person makes in a
  month. Delete a computer and its disk and its place are free again.
- No feature wall on the free plan. Free hours can be spent on any size.
- Anything that raises what a person pays asks first, once, with the price.
- The owner can always see cost against income, and can cap the total.

## Extra use

- Extra hours and extra disk are off until the person turns them on.
- Extra disk is counted by the day, on the GB above the plan's disk. It stops
  the day the disk is gone. It never runs to the end of a month.
- Extra use is charged after use: each time the open amount reaches $5, and
  the rest on the billing date.

## Disk growth

- Inside the plan's disk and the size's limit: automatic, no question. ADE
  says so afterwards.
- The first growth into paid disk asks once, with the price and a cleanup
  option. After that, a monthly limit the person sets lets it continue.
- With extra disk off, or on the free plan, the answer is a plain sentence
  that names the two ways out: delete a computer, or a bigger plan.
- A grow happens at an idle moment, or on a step the person asked for
  (starting Android), because it restarts the computer.

## Cost protection for the owner

- Daily report: provider cost and income for each account, with margin.
- Alarms: an account that costs more than it pays; a day whose total cost
  jumps; the low-wallet and instance-limit alarms.
- A hard limit the owner sets. At that total, no new computer and no disk
  growth until the owner raises it. Wakes of existing computers still work.
- Product analytics for create, wake, sleep, grow, move, size change, delete,
  plan change and each refusal, inside the rules of `docs/logging.md`.
- Error tracking on every failed provider call and every billing mismatch.
