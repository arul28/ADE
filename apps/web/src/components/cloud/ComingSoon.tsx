import { Smartphone } from "lucide-react";
import { AppleMark } from "../home/marks";
import { cn } from "../../lib/cn";
import { CLOUD_PHONE_ON_WEBSITE, PRICING_PLANS, formatCents, formatCount } from "../../lib/cloudPricing";

/** "2.5¢ a minute" for the paid plans that sell extra iPhone minutes. */
const EXTRA_PHONE_MINUTE_LINE = (() => {
  const paid = PRICING_PLANS.filter((plan) => plan.extraPhoneMinuteCents != null);
  if (!paid.length) return null;
  const prices = [...new Set(paid.map((plan) => formatCents(plan.extraPhoneMinuteCents ?? 0)))];
  return `${prices.join(" or ")} a minute past your plan`;
})();

const ALL_ITEMS = [
  {
    id: "ios",
    icon: Smartphone,
    title: "iOS Simulator in the cloud",
    body: "Agents build your iPhone app, run it on a simulator in the cloud and send you screenshots and videos.",
  },
  {
    id: "mac",
    icon: AppleMark,
    title: "Mac computers in the cloud",
    body: "A whole macOS computer for a task, for Xcode builds and Mac apps, with no Mac of your own awake.",
  },
] as const;

/** The ADE Cloud iPhone shows only once it is open to everyone (`CLOUD_PHONE_ON_WEBSITE`). */
const ITEMS = ALL_ITEMS.filter((item) => item.id !== "ios" || CLOUD_PHONE_ON_WEBSITE);

function SoonChip() {
  return (
    <span className="rounded-full border border-[color:var(--color-lamp)]/40 px-2 py-0.5 text-[11.5px] font-medium text-[color:var(--color-lamp)]">
      Coming soon
    </span>
  );
}

/** The ADE Cloud computers that are on the way. `compact` is one line each, for the home page. */
export function ComingSoon({ compact, className }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <ul className={cn("flex flex-wrap justify-center gap-3", className)}>
        {ITEMS.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2.5 rounded-full border border-white/[0.1] bg-white/[0.04] py-1.5 pl-2 pr-2 text-[13.5px] text-white/80 backdrop-blur-sm"
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white/[0.07]">
              <item.icon className="h-3.5 w-3.5 text-white/80" />
            </span>
            {item.title}
            <SoonChip />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={cn("grid gap-4 md:grid-cols-2", className)}>
      {ITEMS.map((item) => (
        <div
          key={item.id}
          className="relative overflow-hidden rounded-[24px] border border-white/[0.08] bg-[linear-gradient(160deg,rgba(124,58,237,0.14),rgba(18,15,46,0.4)_55%)] p-6 sm:p-7"
        >
          <div className="flex items-center justify-between">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/[0.07] ring-1 ring-white/10">
              <item.icon className="h-5 w-5 text-white" />
            </span>
            <SoonChip />
          </div>
          <h3 className="mt-5 text-[18px] font-semibold text-white">{item.title}</h3>
          <p className="mt-2 max-w-[30rem] text-[14.5px] leading-[1.6] text-white/60">{item.body}</p>
          {item.id === "ios" ? (
            <p className="mt-4 text-[13px] text-white/45">
              Plans will include minutes on a phone in the cloud:{" "}
              {PRICING_PLANS.map((plan) => `${formatCount(plan.phoneMinutes)} on ${plan.name}`).join(", ")}.
              {EXTRA_PHONE_MINUTE_LINE ? ` Then ${EXTRA_PHONE_MINUTE_LINE}, billed after use.` : null}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
