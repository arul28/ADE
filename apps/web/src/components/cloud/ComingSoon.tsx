import { Smartphone } from "lucide-react";
import { AppleMark } from "../home/marks";
import { cn } from "../../lib/cn";
import { CLOUD_PHONE_ON_WEBSITE, PHONE_CREDITS_PER_MINUTE, PRICING_PLANS, UNIT, formatCents, formatCount } from "../../lib/cloudPricing";

/** "2.5¢ a minute" for the paid plans that sell extra iPhone minutes (hours only: under credits an extra minute is an extra credit). */
const EXTRA_PHONE_MINUTE_LINE = (() => {
  const paid = PRICING_PLANS.filter((plan) => plan.extraPhoneMinuteCents != null);
  if (!paid.length) return null;
  const prices = [...new Set(paid.map((plan) => formatCents(plan.extraPhoneMinuteCents ?? 0)))];
  return `${prices.join(" or ")} a minute past your plan`;
})();

const ITEMS = [
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

/** The ADE Cloud computers that are on the way: a card each (under a "Coming soon" heading), or (`compact`) one quiet line that says it. */
export function ComingSoon({ compact, className }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <p className={cn("flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px] text-white/55", className)}>
        <span className="font-medium text-white/80">Coming soon</span>
        {ITEMS.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-2">
            <item.icon className="h-4 w-4" /> {item.title}
          </span>
        ))}
      </p>
    );
  }
  return (
    <div className={cn("grid gap-4 md:grid-cols-2", className)}>
      {ITEMS.map((item) => (
        <div
          key={item.id}
          className="relative overflow-hidden rounded-[24px] border border-white/[0.08] bg-[linear-gradient(160deg,rgba(124,58,237,0.14),rgba(18,15,46,0.4)_55%)] p-6 sm:p-7"
        >
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/[0.07] ring-1 ring-white/10">
            <item.icon className="h-5 w-5 text-white" />
          </span>
          <h3 className="mt-5 text-[18px] font-semibold text-white">{item.title}</h3>
          <p className="mt-2 max-w-[30rem] text-[14.5px] leading-[1.6] text-white/60">{item.body}</p>
          {/* Its numbers show only once it is open to everyone (`CLOUD_PHONE_ON_WEBSITE`): they may still change. */}
          {item.id === "ios" && CLOUD_PHONE_ON_WEBSITE ? (
            <p className="mt-4 text-[13px] leading-[1.5] text-white/45">
              {UNIT.credits ? (
                <>It uses your plan's credits: {UNIT.count(PHONE_CREDITS_PER_MINUTE)} a minute.</>
              ) : (
                <>
                  Plans will include minutes on a phone in the cloud:{" "}
                  {PRICING_PLANS.map((plan) => `${formatCount(plan.phoneMinutes)} on ${plan.name}`).join(", ")}.
                  {EXTRA_PHONE_MINUTE_LINE ? ` Then ${EXTRA_PHONE_MINUTE_LINE}, billed after use.` : null}
                </>
              )}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
