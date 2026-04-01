// Stub for @emoji-mart/data to avoid Node.js ESM JSON import-attribute error.
// The real module's main entry is a .json file which Node >=22 refuses to import
// without `with { type: "json" }`.  None of our tests exercise the emoji picker,
// so an empty dataset is sufficient.
export default { categories: [], emojis: {}, aliases: {}, sheet: { cols: 0, rows: 0 } };
