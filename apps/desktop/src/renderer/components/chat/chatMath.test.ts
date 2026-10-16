import { describe, expect, it } from "vitest";

import { normalizeMathDelimiters } from "./chatMath";

/**
 * Which `$` are math. The parser takes only `$$`, so every case below is what
 * the pass hands it: money, shell and code stay as written, TeX in any of the
 * four spellings becomes `$$`.
 */
describe("normalizeMathDelimiters", () => {
  it.each([
    ["money stays money", "between $5 and $10 today", "between $5 and $10 today"],
    ["a lone price stays", "costs $5.", "costs $5."],
    ["a price range stays money", "from $5-$10 each", "from $5-$10 each"],
    ["currency prefix stays", "US$5 or $6", "US$5 or $6"],
    ["opener followed by a space is not math", "$ x$ no", "$ x$ no"],
    ["escaped dollars stay escaped", "escaped \\$5 and \\$x$", "escaped \\$5 and \\$x$"],
    ["inline $x$ becomes math", "inline $x^2$ here", "inline $$x^2$$ here"],
    ["two inline formulas", "$a$ and $b$", "$$a$$ and $$b$$"],
    ["\\(x\\) becomes inline math", "paren \\(a+b\\) end", "paren $$a+b$$ end"],
    ["a whole-line \\[x\\] becomes a display block", "\\[E=mc^2\\]", "$$\nE=mc^2\n$$"],
    ["a whole-line $$x$$ becomes a display block", "$$E=mc^2$$", "$$\nE=mc^2\n$$"],
    ["a list item's $$x$$ stays inline", "  - $$x$$", "  - $$x$$"],
    ["\\[ … \\] lines open and close a display block, TeX inside untouched", "\\[\nx = $y$\n\\]", "$$\nx = $y$\n$$"],
    ["TeX inside an existing $$ block is untouched", "$$\na$b$c\n$$", "$$\na$b$c\n$$"],
    ["code spans keep shell variables", "shell `echo $HOME$PATH` ok", "shell `echo $HOME$PATH` ok"],
    ["fenced code is untouched, prose after it is not", "```sh\nx=$a$b\n```\n$q$", "```sh\nx=$a$b\n```\n$$q$$"],
    ["a ``` line inside a ~~~ block is content, not a fence", "~~~\n$x$\n```\n~~~\n$y$", "~~~\n$x$\n```\n~~~\n$$y$$"],
    ["a tab-indented ``` is not a fence", "\t```not-a-fence\nprose\n\\[a^2\\]", "\t```not-a-fence\nprose\n$$\na^2\n$$"],
    ["an unclosed $$ stays literal instead of swallowing the reply", "text\n$$\nE = mc^2", "text\n\\$\\$\nE = mc^2"],
    ["an unclosed \\[ stays literal", "text\n\\[\nE = mc^2", "text\n\\\\[\nE = mc^2"],
    ["no math at all is returned as is", "no math at all", "no math at all"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });
});
