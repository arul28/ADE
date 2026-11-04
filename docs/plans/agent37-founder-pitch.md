# Agent37 × ADE — founder pitch (draft)

Draft for the owner to edit and send. Facts are from tests on real Agent37
machines on 2026-11-03 (see `agent37-integration.md`).

## The note

> Hi Vishnu,
>
> I build ADE, a local-first workspace where coding agents run in lanes on
> any of your machines, driven from one desktop window, the web, or a phone.
> Every ADE user already has the problem Agent37 solves: they want their
> agents running on a box that is always on, cheap, and not their laptop.
>
> So I made Agent37 a first-class machine in ADE. From the machine picker,
> "New Agent37 machine" creates a box from an ADE template, and it joins the
> user's ADE account with no second sign-in. ADE then treats it like any of
> their computers: lanes, chats, terminals, a private Linux desktop per lane,
> and, on VM boxes, Android emulators. ADE sleeps boxes the moment nothing
> is running and wakes them in about two seconds when the user opens one.
>
> Your docs say it best: on the Ubuntu VM, "Agent37 provides the machine,
> desktop, exec, and SSH; it does not bundle a general desktop-control SDK or
> session recording service." That is exactly what ADE is. Every ADE user who
> clicks that button becomes an Agent37 customer, and many will run VMs.
>
> What would make it smoother on your side:
>
> 1. An "ADE on Agent37" page in your docs and an `agent37-ade` template, the
>    way Cursor has one. I have drafted both (below).
> 2. OAuth or a scoped partner key, so users don't paste a full workspace key.
> 3. Instance webhooks: slept, woke, out of budget, suspended.
> 4. Changing type in place (box ↔ VM), or forking into another type.
> 5. A shape above 4 vCPU, or a 4/16 priced for dev boxes.
> 6. A referral credit for users ADE sends you.
>
> Happy to show it live: a cloud lane on Agent37 driving an iOS simulator on
> my Mac and an Android emulator on a VM, from my phone.

## Demo checklist (before sending)

- New Agent37 machine from the picker, signed in with no code.
- A lane on it: chat, terminal, Linux Desktop with Chromium.
- Sleep on idle, wake on open (show the savings line).
- A VM lane with an Android emulator streaming.
- The cross-machine iOS simulator from the cloud chat.

## Draft docs page for Agent37 ("ADE on Agent37")

> **Run ADE lanes on Agent37**
>
> [ADE](https://ade-app.dev) runs coding agents in lanes on any machine in
> your account and drives them from desktop, web, or phone. An Agent37
> instance makes an always-on ADE machine: your repositories, dependencies
> and build caches stay on its disk, and ADE sleeps it whenever nothing is
> running, so you pay for disk alone in between.
>
> **How it works.** ADE creates the instance from the `agent37-ade`
> template, which runs ADE's brain as its main process. The instance joins
> your ADE account with a one-time token and appears in ADE's machine
> picker. ADE talks to it through the ADE relay; the instance needs no
> public port.
>
> **Pick a type.** A default instance runs lanes, agents and a Linux
> desktop per lane. A `vm` instance adds Docker and Android emulators.
>
> **Set up.** In ADE, open Settings › Integrations › Agent37 and connect
> your workspace. Then choose "New Agent37 machine" in any machine picker.
>
> **Billing.** Agent37 bills compute and disk through your wallet; your
> agents' model usage bills through your own providers.

## Provider description (one paragraph, for listings)

> Agent37 runs ADE machines on Linux instances: always-on homes for your
> lanes and agents that keep the checkout, dependencies and build cache on
> disk, sleep whenever nothing runs and wake in seconds, with a VM type for
> Docker and Android emulators.
