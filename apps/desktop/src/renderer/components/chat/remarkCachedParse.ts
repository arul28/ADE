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
/**
 * A tree costs far more heap than its text: measured on ADE's own docs cut
 * into reply-sized parts (remark-parse + GFM, Node 26), about 360 bytes per
 * node and 11 bytes per source character. At the character cap alone that
 * is about 45 MB, so the cache also stops at this estimate of its retained
 * size.
 */
const MAX_CACHED_BYTES = 24 * 1024 * 1024;
const BYTES_PER_NODE = 360;
/** Short texts parse faster than they clone; a long streamed tail is not reused. */
const MIN_CACHED_LENGTH = 200;
const MAX_CACHED_LENGTH = 200_000;

type CachedTree = { tree: Root; bytes: number };

const trees = new Map<string, CachedTree>();
let cachedChars = 0;
let cachedBytes = 0;

function countNodes(node: unknown): number {
  let count = 0;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as { children?: unknown } | null;
    if (!current || typeof current !== "object") continue;
    count += 1;
    const children = current.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child);
    }
  }
  return count;
}

function remember(text: string, tree: Root): void {
  // The key string is kept too (two bytes a character at most).
  const bytes = countNodes(tree) * BYTES_PER_NODE + text.length * 2;
  trees.set(text, { tree, bytes });
  cachedChars += text.length;
  cachedBytes += bytes;
  while (trees.size > MAX_CACHED_TREES || cachedChars > MAX_CACHED_CHARS || cachedBytes > MAX_CACHED_BYTES) {
    const oldest = trees.entries().next().value;
    if (oldest === undefined) break;
    trees.delete(oldest[0]);
    cachedChars -= oldest[0].length;
    cachedBytes -= oldest[1].bytes;
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
      return structuredClone(cached.tree);
    }
    const tree = parse(text, file);
    remember(text, structuredClone(tree));
    return tree;
  };
}
