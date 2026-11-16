import type { ReactNode } from "react";
import { AppWindow, Cloud, Globe, Monitor, Terminal } from "lucide-react";
import { AndroidMark, AppleMark, WindowsMark } from "./marks";

/*
 * The devices agents get, as one lineup on the page itself: a Mac display
 * with an iPhone and an Android phone in front of it. No cards and no
 * screenshots of ADE's chat: each screen is what the agent drove, captured
 * by ADE on November 16, 2026. The iPhone is a simulator on a Mac Studio and
 * the Mac is that Mac Studio's private lane screen, both driven from a
 * Windows PC; the Android phone is an emulator on that PC. The rings mark
 * where an agent is tapping or clicking.
 */

type Device = { icon: ReactNode; name: string; cloud?: boolean };

const DEVICES: Device[] = [
  { icon: <AppleMark className="h-[15px] w-[15px]" />, name: "iPhone" },
  { icon: <AndroidMark className="h-[17px] w-[17px] text-[#3ddc84]" />, name: "Android", cloud: true },
  { icon: <Monitor className="h-4 w-4" strokeWidth={1.8} />, name: "Mac" },
  { icon: <WindowsMark className="h-[14px] w-[14px] text-[#3ea6ff]" />, name: "Windows" },
  { icon: <Terminal className="h-4 w-4 text-[#fbbf24]" strokeWidth={1.8} />, name: "Linux", cloud: true },
  { icon: <Globe className="h-4 w-4 text-[#22d3ee]" strokeWidth={1.8} />, name: "Browser" },
  { icon: <AppWindow className="h-4 w-4 text-[#9feaf9]" strokeWidth={1.8} />, name: "Your own app" },
];

export function ToolsSection() {
  return (
    <section aria-labelledby="tools-title" className="relative mx-auto max-w-[1320px] px-5 pt-[clamp(8px,1vw,16px)] sm:px-8">
      <div className="mx-auto max-w-[820px] text-center">
        <h2 id="tools-title" className="font-display text-white" style={{ fontSize: "clamp(32px, 3.6vw, 52px)", lineHeight: 1.04, letterSpacing: "-0.04em" }}>
          Every device, for your agents.
          <br />
          <span className="text-white/45">On your computers, or ours.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-[40rem] text-[clamp(15px,1.2vw,17px)] leading-[1.6] text-white/60">
          Agents run your app on a real iPhone simulator, an Android emulator and their own private desktop, then show you what they saw.
        </p>
      </div>

      <div className="hidden sm:block">
        <Lineup />
      </div>
      <MobileLineup />

      <ul className="mx-auto mt-[clamp(28px,3vw,44px)] flex max-w-[980px] flex-wrap items-center justify-center gap-x-7 gap-y-3 text-[15px] text-white/80">
        {DEVICES.map((device) => (
          <li key={device.name} className="inline-flex items-center gap-2">
            <span className="text-white">{device.icon}</span>
            {device.name}
            {device.cloud && <Cloud aria-label="also on ADE Cloud" className="h-3.5 w-3.5 text-[#c4b5fd]" />}
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-3 max-w-[44rem] text-center text-[14px] leading-relaxed text-white/45">
        Any of your computers can use another's: drive your Mac's iPhone from a Windows laptop. <Cloud className="mb-0.5 inline h-3.5 w-3.5 text-[#c4b5fd]" /> also on ADE
        Cloud computers.
      </p>
    </section>
  );
}

/** On a phone the lineup would shrink the phones to stamps: the two phones side by side, the Mac under them. */
function MobileLineup() {
  return (
    <div className="mt-9 sm:hidden">
      <div className="grid grid-cols-2 gap-4 px-2">
        <Phone className="relative" src="/images/home/tools/iphone.webp" width={603} height={1311} alt="ade-app.dev in Safari on an iPhone 17 simulator" notch="island" tap={{ x: 33, y: 68.5 }} />
        <Phone className="relative" src="/images/home/tools/android.webp" width={540} height={1200} alt="ade-app.dev in Chrome on an Android emulator" notch="hole" tap={{ x: 30, y: 67.5 }} />
      </div>
      <div className="mt-5 rounded-[10px] bg-[#0b0b0e] p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]">
        <img src="/images/home/tools/mac.webp" alt="An agent's private Mac desktop with ade-app.dev open in Safari" width={1920} height={1080} decoding="async" className="block h-auto w-full rounded-[7px]" />
      </div>
    </div>
  );
}

/** The Mac display at the back, the two phones in front of its lower corners. */
function Lineup() {
  return (
    <div className="relative mx-auto mt-[clamp(36px,4vw,64px)] aspect-[1180/700] w-full max-w-[1180px]">
      <div aria-hidden className="pointer-events-none absolute inset-x-[10%] top-[8%] bottom-[2%] rounded-[50%] opacity-70 blur-[60px]" style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(124,58,237,0.35), rgba(59,130,246,0.12) 60%, transparent 75%)" }} />

      {/* Mac display */}
      <figure className="absolute left-1/2 top-0 w-[76%] -translate-x-1/2">
        <div className="relative rounded-[1.6%/2.8%] bg-[#0b0b0e] p-[0.9%] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.1),inset_0_0_0_1px_rgba(255,255,255,0.04)]">
          <div className="relative overflow-hidden rounded-[0.7%/1.25%]">
            <img src="/images/home/tools/mac.webp" alt="An agent's private Mac desktop with ade-app.dev open in Safari" width={1920} height={1080} decoding="async" className="block h-auto w-full" />
            <Pointer x={51.8} y={7.7} />
          </div>
        </div>
        <div aria-hidden className="mx-auto h-[min(6vw,64px)] w-[16%] bg-[linear-gradient(180deg,#26262c,#141418)] [clip-path:polygon(12%_0,88%_0,100%_100%,0_100%)]" />
        <div aria-hidden className="mx-auto h-[min(0.8vw,8px)] w-[28%] rounded-t-[4px] bg-[linear-gradient(180deg,#2c2c33,#16161a)] shadow-[0_12px_30px_-8px_rgba(0,0,0,0.8)]" />
        <figcaption className="sr-only">Mac desktop</figcaption>
      </figure>

      {/* iPhone */}
      <Phone
        className="absolute bottom-0 left-[3%] w-[19%]"
        src="/images/home/tools/iphone.webp"
        width={603}
        height={1311}
        alt="ade-app.dev in Safari on an iPhone 17 simulator"
        notch="island"
        tap={{ x: 33, y: 68.5 }}
      />

      {/* Android */}
      <Phone
        className="absolute bottom-0 right-[3%] w-[18%]"
        src="/images/home/tools/android.webp"
        width={540}
        height={1200}
        alt="ade-app.dev in Chrome on an Android emulator"
        notch="hole"
        tap={{ x: 30, y: 67.5 }}
      />
    </div>
  );
}

function Phone({
  className,
  src,
  width,
  height,
  alt,
  notch,
  tap,
}: {
  className: string;
  src: string;
  width: number;
  height: number;
  alt: string;
  notch: "island" | "hole";
  tap: { x: number; y: number };
}) {
  return (
    <figure className={className}>
      <div className="relative rounded-[15%/7%] bg-[#0a0a0c] p-[3.2%] shadow-[0_40px_90px_-20px_rgba(0,0,0,0.95),0_0_0_1.5px_#2c2c33,inset_0_0_0_1px_rgba(255,255,255,0.06)]">
        <div className="relative overflow-hidden rounded-[12.5%/5.8%]">
          <img src={src} alt={alt} width={width} height={height} decoding="async" className="block h-auto w-full" />
          {notch === "island" ? (
            <span aria-hidden className="absolute left-1/2 top-[1.3%] h-[3.1%] w-[30%] -translate-x-1/2 rounded-full bg-black" />
          ) : (
            <span aria-hidden className="absolute left-1/2 top-[1.1%] h-[2.2%] w-[5%] -translate-x-1/2 rounded-full bg-black" />
          )}
          <Tap x={tap.x} y={tap.y} />
        </div>
      </div>
    </figure>
  );
}

/** Where an agent taps: a ring that pulses. Positions are percentages of the screen. */
function Tap({ x, y }: { x: number; y: number }) {
  return (
    <span aria-hidden className="pointer-events-none absolute" style={{ left: `${x}%`, top: `${y}%` }}>
      <span className="absolute -left-[14px] -top-[14px] h-7 w-7 rounded-full border-2 border-white/90 bg-white/25 motion-safe:animate-[ade-tap_2.4s_ease-out_infinite]" />
    </span>
  );
}

/** An agent's pointer on the Mac, clicking. */
function Pointer({ x, y }: { x: number; y: number }) {
  return (
    <span aria-hidden className="pointer-events-none absolute" style={{ left: `${x}%`, top: `${y}%` }}>
      <span className="absolute -left-[12px] -top-[12px] h-6 w-6 rounded-full border-2 border-[#c4b5fd] bg-[#a78bfa]/25 motion-safe:animate-[ade-tap_2.4s_ease-out_infinite]" />
      <svg viewBox="0 0 24 24" className="absolute left-0 top-0 h-5 w-5 drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]">
        <path d="M4 2.5v17l4.6-4.3 3 6.6 2.8-1.3-3-6.5H18L4 2.5Z" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
