import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { elementText, replaceComments, replaceElements, replaceEndTags, replaceTags, tagNames, truncateUtf16 } from "../src/html.ts";

// Each scanner against the regular expression it replaces (the reference is only safe on short input).
const RAW = ["script", "style", "noscript", "svg", "template"];
const START = ["p", "div", "br", "li", "tr", "h1", "h6", "table", "/p", "/div"];
const END = ["p", "div", "li", "tr", "h1", "h6", "table", "section"];
const alt = (names: string[]) => names.map((name) => name.replace("/", "\\/")).join("|");
const reference = {
  comments: (s: string) => s.replace(/<!--[\s\S]*?-->/g, "#"),
  elements: (s: string) => s.replace(new RegExp(`<(${alt(RAW)})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), "#"),
  tags: (s: string) => s.replace(new RegExp(`<(?:${alt(START)})\\b[^>]*>`, "gi"), "#"),
  anyTag: (s: string) => s.replace(/<[^>]*>/g, "#"),
  endTags: (s: string) => s.replace(new RegExp(`<\\/(?:${alt(END)})\\s*>`, "gi"), "#"),
  title: (s: string) => s.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1],
};
const scanners: Record<keyof typeof reference, (s: string) => string | undefined> = {
  comments: (s) => replaceComments(s, "#"),
  elements: (s) => replaceElements(s, tagNames(RAW), "#"),
  tags: (s) => replaceTags(s, tagNames(START), "#"),
  anyTag: (s) => replaceTags(s, null, "#"),
  endTags: (s) => replaceEndTags(s, tagNames(END), "#"),
  title: (s) => elementText(s, "title"),
};
const keys = Object.keys(reference) as (keyof typeof reference)[];
const token = fc.constantFrom("<", ">", "/", "</", "<!--", "-->", "--", "-", "!", "<!", "<title>", "</title >", "<TITLE x>", "title", "<script>",
  "</script>", "</SCRIPT\t>", "<scripts>", "script", "<style a='b'>", "</style>", "<Svg>", "</svg >", "<noscript>", "</noscript>", "<template>",
  "</template>", "<p>", "<P class=x>", "</p>", "</P\n>", "<pre>", "<br/>", "<BR>", "<div>", "</div>", "<li>", "</li>", "<h1>", "</h1>", "<h6 x>",
  "</h7>", "<tr>", "</tr>", "<table>", "</table>", "</section>", "word", "_", "1", " ", "\n", "\t", "\r", "\u00a0", "\u2028", "\u3000", "\ufeff",
  "\u200b", "\u017f", "\u212a", "\u0130", "&amp;", "\ud83d\ude00");

describe("linear HTML scanners", () => {
  test("match the regular expressions they replace on generated markup", () => {
    fc.assert(fc.property(fc.array(token, { maxLength: 40 }), (parts) => {
      const page = parts.join("");
      for (const key of keys) expect(scanners[key](page)).toEqual(reference[key](page));
    }), { numRuns: 3000 });
  });

  test("match on hand-picked edge cases", () => {
    const pages = ["", "<", ">", "<!-->", "<!--->", "<!---->", "<!-- a -->b<!-- c", "<!-<!-- x --->", "<script>a</script>b<script>c",
      "<script x>a</SCRIPT  >", "<scriptx>a</scriptx>", "<svg><svg>a</svg>", "<style>a</style</style >", "<p", "<p>", "<p/>", "<px>", "</p", "</p   x>",
      "</p   >", "</p\u3000>", "<title>a</title>", "<title>a", "<title<title>a</title>", "<TITLE>\u017f</title>"];
    for (const page of pages) for (const key of keys) expect(scanners[key](page)).toEqual(reference[key](page));
  });

  test("truncateUtf16 never leaves half of a surrogate pair", () => {
    expect(truncateUtf16("ab\ud83d\ude00c", 3)).toBe("ab");
    expect(truncateUtf16("ab\ud83d\ude00c", 4)).toBe("ab\ud83d\ude00");
    expect(truncateUtf16("abc", 5)).toBe("abc");
    expect(truncateUtf16("ab\ud83dc", 3)).toBe("ab\ud83d"); // a lone surrogate is not a pair
  });

  test("rejects names the scanners cannot match the way the regex does", () => {
    for (const name of ["Script", "", "a-", "p q"]) expect(() => tagNames([name])).toThrow();
  });
});

/** Fastest of a few runs, so a GC pause or a JIT compile is not measured. */
function fastest(run: () => unknown, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) { const started = performance.now(); run(); best = Math.min(best, performance.now() - started); }
  return best;
}

// Runs after the equivalence tests on purpose: their many short inputs warm the JIT into the state in which Bun's
// String.prototype.indexOf(…, from) degraded to O(n) per call and an earlier version of these scanners went quadratic.
describe("linear HTML scanners: cost", () => {
  // Inputs on which a backtracking /<[^>]*>/, a per-tag rescan for `>` or an end tag, or a slow indexOf is quadratic.
  const attacks: Record<string, (n: number) => string> = {
    "<": (n) => "<".repeat(n),
    "<script": (n) => "<script".repeat(n / 7),
    "<script>": (n) => "<script>".repeat(n / 8),
    "<svg then one >": (n) => `${"<svg".repeat(n / 4)}>`,
    "<p": (n) => "<p".repeat(n / 2),
    "</p and spaces": (n) => `</p${" ".repeat(n)}`,
    "</p</p": (n) => "</p".repeat(n / 3),
    "<!--": (n) => "<!--".repeat(n / 4),
    "-->": (n) => `<!--${"--".repeat(n / 2)}`,
    "<title": (n) => `${"<title".repeat(n / 6)}>`,
    "<style></style": (n) => `<style>${"</style".repeat(n / 7)}>`,
  };
  const all = (s: string) => keys.map((key) => scanners[key](s));

  test("doubling the input at most triples the time, and 1 MiB takes well under a second", () => {
    for (const [name, make] of Object.entries(attacks)) {
      const small = make(512 * 1024), large = make(1024 * 1024);
      all(small); all(large); // warm up
      const a = fastest(() => all(small)), b = fastest(() => all(large));
      expect({ name, linear: b <= 3 * a + 5, fast: b < 500 }).toEqual({ name, linear: true, fast: true });
    }
  }, 60_000);
});
