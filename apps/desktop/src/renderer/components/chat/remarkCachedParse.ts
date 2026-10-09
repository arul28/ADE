/** The syntax tree remark-parse returns; only cloned and handed back here. */
type Root = { type: string };

/**
 * Reuse the markdown parse of text this renderer has already parsed.
 *
 * Opening a chat mounts every visible row, and every row re-parsed its
 * markdown from scratch (micromark, the bulk of a chat switch's long task).
 * Messages do not change once written, so the syntax tree of each text is
 * kept and a clone handed out: later plugins in the pipeline (entity links)
 * transform the tree in place, so the cached original is never given away.
 *
 * Only for pipelines that parse with the same extensions (GFM, as the chat
 * markdown does). The cache is keyed by the text alone.
 */
const MAX_CACHED_TREES = 600;
const MAX_CACHED_CHARS = 4_000_000;
/** Short texts parse faster than they clone; a long streamed tail is not reused. */
const MIN_CACHED_LENGTH = 200;
const MAX_CACHED_LENGTH = 200_000;

const trees = new Map<string, Root>();
let cachedChars = 0;

function remember(text: string, tree: Root): void {
  trees.set(text, tree);
  cachedChars += text.length;
  while (trees.size > MAX_CACHED_TREES || cachedChars > MAX_CACHED_CHARS) {
    const oldest = trees.keys().next().value;
    if (oldest === undefined) break;
    trees.delete(oldest);
    cachedChars -= oldest.length;
  }
}

type ParserProcessor = { parser?: (document: string, file: unknown) => Root };

export function remarkCachedParse(this: ParserProcessor): void {
  const parse = this.parser;
  if (typeof parse !== "function") return;
  this.parser = (document: string, file: unknown): Root => {
    const text = String(document);
    if (text.length < MIN_CACHED_LENGTH || text.length > MAX_CACHED_LENGTH) return parse(text, file);
    const cached = trees.get(text);
    if (cached) {
      // Refresh recency.
      trees.delete(text);
      trees.set(text, cached);
      return structuredClone(cached);
    }
    const tree = parse(text, file);
    remember(text, structuredClone(tree));
    return tree;
  };
}
