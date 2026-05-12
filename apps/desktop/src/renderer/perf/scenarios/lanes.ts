import { registerScenario, type ScenarioContext } from "./index";

async function navigateToLanes(ctx: ScenarioContext): Promise<void> {
  ctx.mark("nav.lanes.start");
  await ctx.navigate("/lanes");
  const present = await ctx.waitFor(
    () => document.querySelector("[data-route='lanes']") !== null,
    8_000
  );
  ctx.mark("nav.lanes.done");
  ctx.measure("nav.lanes", "nav.lanes.start", "nav.lanes.done");
  ctx.assert(present, "lanes route did not render main content");
}

function isScrollableElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const overflowY = `${style.overflowY} ${style.overflow}`;
  return /(auto|scroll)/.test(overflowY) && element.scrollHeight > element.clientHeight;
}

function findLanesScrollable(): HTMLElement | null {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      "[data-scrollable], [data-route='lanes'] [class*='overflow'], main [class*='overflow']",
    ),
  ];
  for (const candidate of candidates) {
    if (isScrollableElement(candidate)) return candidate;
  }

  let current = document.querySelector<HTMLElement>("[data-route='lanes']") ?? document.querySelector<HTMLElement>("main");
  while (current) {
    if (isScrollableElement(current)) return current;
    current = current.parentElement;
  }

  const scrollingElement = document.scrollingElement;
  return scrollingElement instanceof HTMLElement && isScrollableElement(scrollingElement)
    ? scrollingElement
    : null;
}

registerScenario({
  id: "lanes.cold-list",
  description: "Cold open of /lanes — measures route mount, first render, settle.",
  run: async (ctx) => {
    await navigateToLanes(ctx);
    await ctx.idle(5_000);
    // Smoke: at least one heading-like element exists.
    const hasHeading = !!document.querySelector("h1, h2, [role='heading']");
    ctx.assert(hasHeading, "no heading visible after lanes mount");
  },
});

registerScenario({
  id: "lanes.switch-rapid",
  description: "Rapid route switching to/from lanes — measures route transition cost.",
  run: async (ctx) => {
    const routes = ["/lanes", "/work", "/lanes", "/files", "/lanes", "/prs", "/lanes"];
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!;
      const tag = route.replace(/\W+/g, "_") + "_" + i;
      ctx.mark(`switch.${tag}.start`);
      await ctx.navigate(route);
      await ctx.waitFor(
        () => document.querySelector(route === "/lanes" ? "[data-route='lanes']" : "main") !== null,
        5_000,
      );
      ctx.mark(`switch.${tag}.done`);
      ctx.measure(`switch.${tag}`, `switch.${tag}.start`, `switch.${tag}.done`);
      await ctx.idle(300);
    }
    ctx.assert(
      window.location.hash.includes("lanes") || window.location.pathname.includes("lanes"),
      "final route is not /lanes"
    );
  },
});

registerScenario({
  id: "lanes.idle-at-rest",
  description: "Sit on /lanes for 30s — measures at-rest CPU/memory and background polling.",
  run: async (ctx) => {
    await navigateToLanes(ctx);
    await ctx.idle(30_000);
    ctx.assert(document.querySelector("main") !== null, "main vanished during idle");
  },
});

registerScenario({
  id: "lanes.stress-poll",
  description: "Sit on /lanes for 2 minutes — catches memory leaks and polling regressions.",
  run: async (ctx) => {
    await navigateToLanes(ctx);
    // Force window focus loops to exercise visibility-driven pollers.
    for (let i = 0; i < 6; i++) {
      await ctx.idle(20_000);
      ctx.mark(`stress.tick.${i}`);
    }
    ctx.assert(document.querySelector("main") !== null, "main vanished during stress");
  },
});

registerScenario({
  id: "lanes.scroll-list",
  description: "Scroll the lanes list rapidly — measures render-on-scroll cost.",
  run: async (ctx) => {
    await navigateToLanes(ctx);
    await ctx.idle(2_000);
    const scrollable = findLanesScrollable();
    if (!scrollable) {
      ctx.assert(false, "no scrollable container found in lanes");
      return;
    }
    ctx.mark("scroll.start");
    for (let i = 0; i < 20; i++) {
      scrollable.scrollTop = (i % 2 === 0 ? scrollable.scrollHeight : 0);
      await ctx.idle(150);
    }
    ctx.mark("scroll.done");
    ctx.measure("scroll.20-cycles", "scroll.start", "scroll.done");
  },
});
