/**
 * Choose the cheapest usable model for a provider.
 *
 * The catalog carries no price, so cost is inferred from the family name — the
 * ordering below is the published Anthropic tier order, cheapest first. A demo
 * that runs against the developer's real subscription has no business picking
 * Opus to read three fake invoices.
 */

const CHEAP_FIRST = ["haiku", "mini", "flash", "small", "sonnet", "gpt-5", "opus"];

export function pickCheapestModel(models, provider) {
  const usable = models.filter(
    (model) => model.provider === provider && model.isAvailable !== false,
  );
  if (usable.length === 0) return null;

  const rank = (model) => {
    const haystack = `${model.id} ${model.runtimeModelId ?? ""} ${model.displayName ?? ""}`.toLowerCase();
    const index = CHEAP_FIRST.findIndex((needle) => haystack.includes(needle));
    return index === -1 ? CHEAP_FIRST.length : index;
  };

  return [...usable].sort((a, b) => {
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    // Same tier: prefer the provider's own default, then a stable id order.
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.id.localeCompare(b.id);
  })[0];
}
