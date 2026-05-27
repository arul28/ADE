import { LINEAR_BRAND } from "./linearBrand";

const LINEAR_ICON_ALIASES: Record<string, string> = {
  robot_face: "🤖",
  robot: "🤖",
  file_folder: "📁",
  folder: "📁",
  clock3: "🕒",
  clock: "🕒",
  history: "🕘",
  link: "🔗",
  chart: "📊",
  graph: "📈",
  rocket: "🚀",
  bug: "🐛",
  hammer: "🔨",
  wrench: "🔧",
  gear: "⚙️",
  lightning: "⚡",
  star: "⭐",
  fire: "🔥",
  calendar: "📅",
  bookmark: "🔖",
  book: "📖",
  code: "💻",
  terminal: "🖥️",
  mobile: "📱",
  globe: "🌍",
  lock: "🔒",
  search: "🔍",
  bell: "🔔",
  mail: "✉️",
  chat: "💬",
  users: "👥",
  user: "👤",
  target: "🎯",
  flag: "🚩",
  ship: "🚢",
  package: "📦",
  inbox: "📥",
  trash: "🗑️",
  paint: "🎨",
  camera: "📷",
  video: "🎬",
  game: "🎮",
  trophy: "🏆",
  gift: "🎁",
  bulb: "💡",
  brain: "🧠",
  puzzle: "🧩",
  shield: "🛡️",
  cloud: "☁️",
  database: "🗄️",
  sync: "🔄",
  refresh: "🔄",
  home: "🏠",
  building: "🏢",
  cart: "🛒",
  money: "💰",
  doc: "📄",
  note: "📝",
  pencil: "✏️",
  drive: "💾",
  lab: "🧪",
  leaf: "🌿",
  plane: "✈️",
  coffee: "☕",
  settings: "⚙️",
  work: "💼",
  mission: "🎯",
  missions: "🎯",
  lane: "🛣️",
  lanes: "🛣️",
  preview: "👁️",
  test: "🧪",
  tui: "🖥️",
  run: "▶️",
  pr: "🔀",
  prs: "🔀",
  review: "👀",
};

function projectIconBackground(color: string | null | undefined): string {
  const normalized = color?.trim();
  if (normalized && /^#[0-9a-f]{6}$/i.test(normalized)) return `${normalized}30`;
  if (normalized && /^#[0-9a-f]{3}$/i.test(normalized)) {
    const [r, g, b] = normalized.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}30`;
  }
  return "rgba(255,255,255,0.08)";
}

export function resolveLinearProjectIcon(icon: string | null | undefined): string | null {
  const trimmed = icon?.trim();
  if (!trimmed) return null;

  const shortcodeMatch = /^:([a-z0-9_+-]+):$/i.exec(trimmed);
  if (shortcodeMatch) {
    return LINEAR_ICON_ALIASES[shortcodeMatch[1].toLowerCase()] ?? null;
  }

  // GraphQL returns raw emoji; SDK may return short names for unknown presets.
  if (!/^[a-z0-9_-]+$/i.test(trimmed)) {
    return trimmed;
  }

  return LINEAR_ICON_ALIASES[trimmed.toLowerCase()] ?? null;
}

export function LinearProjectIcon({
  icon,
  color,
  name,
  size = 16,
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  name: string;
  size?: number;
}) {
  const glyph = resolveLinearProjectIcon(icon);
  const background = projectIconBackground(color);

  if (glyph) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[4px] leading-none"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(10, size - 5),
          background,
        }}
        aria-hidden="true"
      >
        {glyph}
      </span>
    );
  }

  return (
    <span
      className="grid shrink-0 place-items-center rounded-[4px] text-[9px] font-semibold text-white/90"
      style={{
        width: size,
        height: size,
        background: color ?? LINEAR_BRAND.primaryBright,
      }}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
