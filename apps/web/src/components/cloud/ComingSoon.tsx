import { AndroidMark, AppleMark, WindowsMark } from "../home/marks";
import { cn } from "../../lib/cn";

const ITEMS = [
  {
    id: "mac",
    icon: AppleMark,
    title: "Mac computers in the cloud",
    body: "A whole macOS computer for a task, for Xcode builds and Mac apps, with no Mac of your own awake.",
  },
  {
    id: "windows",
    icon: WindowsMark,
    title: "Windows computers in the cloud",
    body: "A whole Windows computer for a task, for Windows apps, builds and tests.",
  },
  {
    id: "android",
    icon: AndroidMark,
    title: "Android emulator on every computer",
    body: "Agents run your Android app on any ADE Cloud computer, Small included.",
  },
] as const;

/** The ADE Cloud computers and tools that are on the way, a card each. */
export function ComingSoon({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-4 md:grid-cols-2 lg:grid-cols-3", className)}>
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
        </div>
      ))}
    </div>
  );
}
