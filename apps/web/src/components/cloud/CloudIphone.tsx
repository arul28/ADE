import { ArrowRight, Clapperboard, Laptop, MousePointerClick, Smartphone } from "lucide-react";
import { PHONE_CREDITS_PER_MINUTE, PRICING_SIZES, formatCount } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { adPriceOf, type Machine, type PricingView } from "../../lib/pricingView";
import { AppleMark } from "../home/marks";
import { LINKS } from "../../lib/links";
import { BRAND } from "../../../../desktop/src/shared/brand";

const AMBER = "#fdba74";

/**
 * Each size once, then the iPhone: one panel, a column each (a row each on a
 * narrow screen), with the rate as the big number. Under Pricing v3 the rates
 * come from the visitor's view: the Mac joins when it is open to all, and with
 * ads each rate shows the ad price with the full price struck beside it.
 */
export function SizesStrip({ className, view }: { className?: string; view?: PricingView }) {
  const tiles: Tile[] = view?.v3 ? v3Tiles(view) : todayTiles();
  return (
    <div
      className={cn(
        "grid overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#100e22] divide-y divide-white/[0.07] lg:divide-x lg:divide-y-0",
        tiles.length === 6 ? "lg:grid-cols-6" : tiles.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4",
        className,
      )}
    >
      {tiles.map((tile) => (
        <div
          key={tile.id}
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 p-5 lg:grid-cols-1 lg:p-6",
            tile.phone && "bg-[linear-gradient(160deg,rgba(253,186,116,0.12),transparent_70%)]",
            tile.mac && "bg-[linear-gradient(160deg,rgba(196,181,253,0.12),transparent_70%)]",
          )}
        >
          <div className="col-start-1 row-start-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {tile.phone ? <Smartphone className="h-4 w-4" style={{ color: AMBER }} /> : null}
            {tile.mac ? <AppleMark className="h-4 w-4 text-[#c4b5fd]" /> : null}
            <span className="text-[16px] font-semibold text-white">{tile.name}</span>
          </div>
          <div className="col-start-2 row-span-2 row-start-1 self-center text-right lg:col-start-1 lg:row-span-1 lg:row-start-2 lg:mt-5 lg:text-left">
            {tile.struck != null ? (
              <s className="mr-2 font-display text-[22px] leading-none text-white/35 decoration-white/45 decoration-[1.5px] lg:text-[26px]">
                <span className="sr-only">Full price </span>
                {tile.struck}
              </s>
            ) : null}
            <span
              className={cn("font-display text-[34px] leading-none lg:text-[44px]", tile.rate === "Free" ? "text-[color:var(--color-lamp)]" : "text-white")}
              style={tile.phone ? { color: AMBER } : tile.mac ? { color: "#c4b5fd" } : undefined}
            >
              {tile.struck != null ? <span className="sr-only">With ads </span> : null}
              {tile.rate}
            </span>
            <span className="mt-1 block text-[13px] text-white/50">{tile.per}</span>
            {tile.note ? <span className="mt-1 block text-[12px] leading-[1.4] text-white/40">{tile.note}</span> : null}
          </div>
          <div className="col-start-1 row-start-2 mt-1 lg:row-start-3 lg:mt-5">
            <p className="text-[14px] text-white/80">{tile.spec}</p>
            <p className="text-[13px] text-white/45">{tile.use}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

type Tile = { id: string; name: string; rate: string; struck?: string | null; per: string; note?: string; spec: string; use: string; phone: boolean; mac?: boolean };

function todayTiles(): Tile[] {
  return [
    ...PRICING_SIZES.map((size) => ({
      id: size.id,
      name: size.machine,
      rate: size.rate > 0 ? formatCount(size.rate) : "Free",
      per: size.rate > 0 ? `${size.rate === 1 ? "credit" : "credits"} an hour` : "on paid plans, or Free with ads",
      spec: `${size.cpu} CPUs, ${size.memoryGb} GB`,
      use: size.use,
      phone: false,
    })),
    { id: "iphone", name: "iOS Simulator", rate: formatCount(PHONE_CREDITS_PER_MINUTE), per: `${PHONE_CREDITS_PER_MINUTE === 1 ? "credit" : "credits"} a minute`, spec: "An iPhone in the cloud", use: "No Mac needed", phone: true },
  ];
}

/**
 * The words under a rate, in the app's price forms (`copy.md`): "credits an
 * hour with ads" beside the struck full price, "credits an hour · 8 with ads"
 * with no ads where there are ads, and only "credits an hour" elsewhere.
 */
function priceWords(view: PricingView, machine: Machine): string {
  const unit = `${machine.price.now === 1 ? "credit" : "credits"} a${machine.per === "hour" ? "n hour" : " minute"}`;
  if (!view.ads) return unit;
  if (view.withAds) return `${unit} with ads`;
  const ad = adPriceOf(machine.price.now, view.ads.discountPct);
  return ad === machine.price.now ? unit : `${unit} · ${formatCount(ad)} with ads`;
}

function v3Tiles(view: PricingView): Tile[] {
  const small = PRICING_SIZES.find((size) => size.rate === 0)!;
  const freeSmallRate = view.freeSmall.struck ?? view.freeSmall.now;
  const smallTile: Tile = {
    id: small.id,
    name: small.label,
    rate: "Free",
    per: view.freeSmallFree ? "on every plan" : view.ads ? "on paid plans, and on Free with ads" : "on paid plans",
    note: view.freeSmallFree ? undefined : `${formatCount(freeSmallRate)} credits an hour on Free${view.ads ? " with no ads" : ""}`,
    spec: `Linux, ${small.cpu} CPUs, ${small.memoryGb} GB`,
    use: small.use,
    phone: false,
  };
  return [
    smallTile,
    ...view.machines.map((machine) => ({
      id: machine.id,
      name: machine.kind === "linux" ? (PRICING_SIZES.find((size) => size.id === machine.id)?.label ?? machine.name) : machine.name,
      rate: formatCount(machine.price.now),
      struck: machine.price.struck != null ? formatCount(machine.price.struck) : null,
      per: priceWords(view, machine),
      spec: machine.kind === "linux" ? `Linux, ${machine.specs.replace(", Docker and Android", "")}` : machine.specs,
      use: machine.use,
      phone: machine.kind === "iphone",
      mac: machine.kind === "mac",
    })),
  ];
}

/** Home page: the ADE Cloud iPhone's own band, a real capture beside a short pitch. */
export function CloudIphoneBand() {
  return (
    <div className="mt-16 overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(150deg,rgba(253,186,116,0.10),rgba(18,15,46,0.55)_45%,rgba(12,10,26,0.9))]">
      <div className="grid items-center gap-8 p-6 sm:p-10 md:grid-cols-[minmax(0,4fr)_minmax(0,6fr)] lg:gap-14">
        <div className="mx-auto w-[min(100%,300px)] rounded-[44px] bg-[#1b1b22] p-[9px] shadow-[0_40px_80px_-20px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.14)]">
          <img src="/images/home/mockup/crumb-phone.png" alt={`An app running on the ${BRAND.CLOUD_NAME} iPhone`} className="block h-auto w-full rounded-[36px]" />
        </div>
        <div>
          <p className="inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: AMBER }}>
            <Smartphone className="h-3.5 w-3.5" /> {BRAND.CLOUD_NAME} iPhone
          </p>
          <h3 className="mt-3 text-[clamp(24px,2.3vw,32px)] font-medium leading-[1.2] tracking-[-0.02em] text-white">
            No Mac? Ship iPhone apps anyway.
          </h3>
          <p className="mt-3 max-w-[32rem] text-[16px] leading-relaxed text-white/60">
            Agents build your app and test it on an iPhone in the cloud.
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-[15px] text-white/75">
            {[
              { icon: <Laptop className="h-4 w-4" />, text: "From Windows, Linux, the web or your phone" },
              { icon: <MousePointerClick className="h-4 w-4" />, text: "Taps, types and scrolls through every screen" },
              { icon: <Clapperboard className="h-4 w-4" />, text: "A recording of each run in the chat" },
            ].map((point) => (
              <li key={point.text} className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0" style={{ color: AMBER }}>{point.icon}</span>
                {point.text}
              </li>
            ))}
          </ul>
          <a href={`${LINKS.docs}/tools/ios-simulator`} target="_blank" rel="noreferrer" className="focus-ring group mt-6 inline-flex items-center gap-1.5 rounded-md text-[15px] font-medium" style={{ color: AMBER }}>
            How the cloud iPhone works
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
