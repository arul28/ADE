import React from "react";
import emojiNames from "@lobehub/emojilib";
import { LANE_EMOJI_OPTIONS, normalizeLaneEmoji } from "../../../shared/laneEmoji";

type EmojiCategory =
  | "Developer"
  | "Smileys"
  | "People"
  | "Animals & nature"
  | "Food & drink"
  | "Travel & places"
  | "Activities"
  | "Objects"
  | "Symbols"
  | "Flags";

type EmojiOption = {
  emoji: string;
  name: string;
  category: EmojiCategory;
  searchText: string;
};

const CATEGORY_ORDER: EmojiCategory[] = [
  "Developer",
  "Smileys",
  "People",
  "Animals & nature",
  "Food & drink",
  "Travel & places",
  "Activities",
  "Objects",
  "Symbols",
  "Flags",
];

const INITIAL_EMOJI_LIMIT = 168;
const EMOJI_BATCH_SIZE = 168;

function categoryForName(name: string): EmojiCategory {
  const slug = name.toLowerCase();
  if (slug.startsWith("flag-")) return "Flags";
  if (/(face|smile|frown|kiss|wink|blush|sweat|tongue|tears|heart-eyes|speak-no-evil|see-no-evil|hear-no-evil|poop|ghost|skull)/.test(slug)) {
    return "Smileys";
  }
  if (/(person|people|man|woman|child|family|hand|arm|leg|foot|ear|eye|nose|mouth|hair|baby|dancer|worker|student|judge|pilot|guard|firefighter|police|doctor|scientist|technologist|singer|artist|cook|farmer|mechanic)/.test(slug)) {
    return "People";
  }
  if (/(animal|cat|dog|monkey|bird|fish|whale|dolphin|bug|insect|spider|snake|turtle|plant|tree|flower|leaf|mushroom|seedling|cactus|herb|bouquet|rose|tulip|sunflower|four-leaf)/.test(slug)) {
    return "Animals & nature";
  }
  if (/(food|fruit|vegetable|meat|bread|rice|noodle|curry|salad|sandwich|pizza|burger|fries|taco|burrito|sushi|cookie|cake|pie|chocolate|coffee|tea|drink|beverage|wine|beer|cocktail|milk|cup|popcorn|honey|salt|spoon|fork|knife)/.test(slug)) {
    return "Food & drink";
  }
  if (/(car|taxi|bus|train|truck|bike|bicycle|motorcycle|ship|boat|airplane|helicopter|rocket|satellite|house|building|hotel|school|hospital|castle|bridge|mountain|beach|island|camping|tent|railway|station|road|map|globe|weather|sun|moon|cloud|snow|rain|umbrella|fountain|lighthouse|fuel|construction)/.test(slug)) {
    return "Travel & places";
  }
  if (/(sport|ball|trophy|medal|game|playing|dice|chess|puzzle|ticket|theater|circus|art|paint|performing|fishing|ski|surf|bowling|cricket|rugby|baseball|basketball|football|soccer|tennis|volleyball|badminton|boxing|martial)/.test(slug)) {
    return "Activities";
  }
  if (/(computer|keyboard|mouse|phone|telephone|book|paper|pencil|pen|memo|folder|file|camera|light|bulb|tool|wrench|hammer|gear|battery|battery|printer|disk|floppy|watch|clock|calendar|briefcase|envelope|mailbox|package|gift|gem|money|wallet|credit-card|chart|bar-chart|clipboard|magnifying|microscope|telescope|satchel|luggage|bell|speaker|microphone|headphone|video|film|radio|television|plug|electric|key|lock|door|window|chair|bed|mirror|soap|toothbrush|broom|bucket|shopping|cart|recycle|trash|waste|fire-extinguisher)/.test(slug)) {
    return "Objects";
  }
  return "Symbols";
}

function buildEmojiOptions(): EmojiOption[] {
  const curated = LANE_EMOJI_OPTIONS.map(({ emoji, meaning }) => ({
    emoji,
    name: meaning,
    category: "Developer" as const,
    searchText: `${emoji} ${meaning}`.toLowerCase(),
  }));
  const curatedEmoji = new Set(curated.map((option) => option.emoji));
  const rest = Object.entries(emojiNames)
    .filter(([emoji]) => !curatedEmoji.has(emoji))
    .flatMap(([emoji, slug]) => {
      try {
        normalizeLaneEmoji(emoji);
      } catch {
        return [];
      }
      const name = slug.replace(/-/g, " ");
      return [{
        emoji,
        name,
        category: categoryForName(slug),
        searchText: `${emoji} ${slug} ${name}`.toLowerCase(),
      }];
    });
  return [...curated, ...rest];
}

const ALL_EMOJI_OPTIONS = buildEmojiOptions();

export default function LaneEmojiPickerContent({
  value,
  onChange,
  onClose,
  disabled,
  label,
}: {
  value: string | null | undefined;
  onChange: (emoji: string | null) => void;
  onClose: () => void;
  disabled: boolean;
  label: string;
}) {
  const [category, setCategory] = React.useState("All");
  const [search, setSearch] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_EMOJI_LIMIT);
  const [customValue, setCustomValue] = React.useState(value ?? "");
  const customValid = React.useMemo(() => {
    if (!customValue.trim()) return true;
    try {
      normalizeLaneEmoji(customValue);
      return true;
    } catch {
      return false;
    }
  }, [customValue]);

  React.useEffect(() => setCustomValue(value ?? ""), [value]);
  React.useEffect(() => setVisibleCount(INITIAL_EMOJI_LIMIT), [category, search]);

  const categoryCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const option of ALL_EMOJI_OPTIONS) {
      counts.set(option.category, (counts.get(option.category) ?? 0) + 1);
    }
    return counts;
  }, []);
  const filteredOptions = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return ALL_EMOJI_OPTIONS.filter((option) => (
      (category === "All" || option.category === category)
      && (!query || option.searchText.includes(query))
    ));
  }, [category, search]);
  const visibleOptions = filteredOptions.slice(0, visibleCount);

  const pick = (emoji: string | null) => {
    setCustomValue(emoji ?? "");
    onChange(emoji);
    onClose();
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-semibold text-fg/80">{label}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[10px] text-muted-fg hover:bg-fg/[0.06] hover:text-fg disabled:opacity-45"
          onClick={() => pick(null)}
          disabled={disabled}
        >
          Clear
        </button>
      </div>
      <div className="mb-2 grid grid-cols-[1fr_118px] gap-1.5">
        <input
          className="h-7 min-w-0 rounded-md border border-fg/[0.1] bg-fg/[0.035] px-2 text-xs text-fg outline-none focus:border-accent/50"
          value={search}
          disabled={disabled}
          aria-label="Search emojis"
          placeholder="Search emojis"
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="h-7 min-w-0 rounded-md border border-fg/[0.1] bg-background px-1.5 text-[10px] text-fg outline-none focus:border-accent/50"
          aria-label="Emoji category"
          value={category}
          disabled={disabled}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="All">All ({ALL_EMOJI_OPTIONS.length})</option>
          {CATEGORY_ORDER.map((name) => {
            const count = categoryCounts.get(name) ?? 0;
            return count > 0 ? <option key={name} value={name}>{name} ({count})</option> : null;
          })}
        </select>
      </div>
      <div className="max-h-48 overflow-y-auto rounded-md">
        <div className="grid grid-cols-8 gap-0.5" role="group" aria-label="Available emojis">
          {visibleOptions.map(({ emoji, name }) => (
            <button
              key={emoji}
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded text-base hover:bg-fg/[0.08] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-45"
              aria-label={`${emoji} ${name}`}
              aria-pressed={value === emoji}
              title={name}
              disabled={disabled}
              onClick={() => pick(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        {visibleOptions.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-fg">No matching emojis</div>
        ) : null}
      </div>
      {visibleCount < filteredOptions.length ? (
        <button
          type="button"
          className="mt-1 w-full rounded-md px-2 py-1 text-[10px] text-muted-fg hover:bg-fg/[0.06] hover:text-fg"
          onClick={() => setVisibleCount((count) => count + EMOJI_BATCH_SIZE)}
        >
          Show {Math.min(EMOJI_BATCH_SIZE, filteredOptions.length - visibleCount)} more
        </button>
      ) : null}
      <label className="mt-2 block text-[10px] text-muted-fg">
        Paste an emoji
        <input
          className="mt-1 h-7 w-full rounded-md border border-fg/[0.1] bg-fg/[0.035] px-2 text-sm text-fg outline-none focus:border-accent/50"
          value={customValue}
          disabled={disabled}
          aria-label="Enter any emoji"
          aria-invalid={!customValid}
          placeholder="Paste one emoji"
          onChange={(event) => {
            const next = event.target.value;
            setCustomValue(next);
            if (!next.trim()) {
              onChange(null);
              return;
            }
            try {
              onChange(normalizeLaneEmoji(next));
            } catch {
              // Keep partial text editable; service validation is final.
            }
          }}
        />
      </label>
      {!customValid ? <div className="mt-1 text-[10px] text-muted-fg">Enter one emoji.</div> : null}
    </>
  );
}
