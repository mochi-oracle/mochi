import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DocumentTooLarge, EmptyDocument, extractText, htmlText, MAX_DOCUMENT_BYTES, MAX_TEXT_CHARS } from "../src/extract.ts";

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

/** The previous regex extractor, verbatim; kept only as the reference for ordinary-sized input (it is quadratic). */
function regexReference(input: string): string {
  const decodeEntities = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
    const lower = entity.toLowerCase();
    if (lower in named) return named[lower]!;
    const numeric = lower.startsWith("&#x") ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10);
    try { return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : "\ufffd"; } catch { return "\ufffd"; }
  });
  const block = /<(?:p|div|br|li|tr|h[1-6]|table|section|article)\b[^>]*>/gi;
  const closeBlock = /<\/(?:p|div|li|tr|h[1-6]|table|section|article)\s*>/gi;
  return decodeEntities(input.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(block, "\n").replace(closeBlock, "\n").replace(/<[^>]*>/g, ""))
    .split(/\r?\n/).map((line) => line.replace(/[\t\f\v ]+/g, " ").trim()).filter(Boolean).join("\n");
}

describe("intake HTML extraction: same text as the previous extractor", () => {
  test("on normal HTML", () => {
    const pages = [
      "<h1> A &amp; B </h1><script>private()</script><p>x&nbsp;&lt;y&gt; &quot;q&quot; &#39; &#65; &#x42;</p><style>hide</style><div>z</div>",
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><TITLE data-x=\"1\">Report <b>2026</b> &#8212; Q3</TITLE><style>body{color:red}</style></head>"
        + "<body><nav><ul><li>Home</li><li>About</li></ul></nav><article><h2 class=\"x\">Revenue rose</h2><p>Revenue rose 12%<br/>year over year.</p>"
        + "<table><tr><td>Q3</td><td>$4.1B</td></tr><tr><td>Q2</td><td>$3.7B</td></tr></table></article><noscript>enable js</noscript>"
        + "<SCRIPT type=\"module\">x()</SCRIPT ><section><p>&quot;Quoted&quot;\t\ttext&nbsp;here</p ></section><H6>Footer</H6></body></html>",
      "<div>a</div>\r\n<div>b</div>\n\n\n\n<div>  c \f d </div>",
      "plain text without tags",
      "<p>Unclosed <script>tail text",
      "<P>Item one<LI>Item two</LI ><BR>Line &#x1F600; &#9999999; &bogus; &AMP;</p>",
    ];
    for (const page of pages) expect(htmlText(page)).toBe(regexReference(page));
  });

  test("on generated markup", () => {
    const token = fc.constantFrom("<", ">", "/", "</", "<script>", "</script>", "</SCRIPT\t>", "<scripts>", "<style a='b'>", "</style >", "<noscript>",
      "</noscript>", "<p>", "<P class=x>", "</p>", "</P\n>", "<pre>", "</pre>", "<br/>", "<BR>", "<div>", "</div >", "<li>", "</li>", "<tr>", "</tr>",
      "<h1>", "</h3>", "<h7>", "</h0>", "<table>", "</table>", "<section>", "</section>", "<article>", "</article>", "<b>", "</b>", "<!--", "-->",
      "&amp;", "&lt;", "&gt;", "&quot;", "&#39;", "&nbsp;", "&#65;", "&#x42;", "&#x110000;", "&#55357;", "&bogus;", "&", "#", ";", " ", "\n", "\r",
      "\r\n", "\t", "\f", "\v", "\u00a0", "\u2028", "\u3000", "\ufeff", "\u017f", "\u212a", "word", "_", "1", "\ud83d\ude00");
    fc.assert(fc.property(fc.array(token, { maxLength: 40 }), (parts) => {
      const page = parts.join("");
      expect(htmlText(page)).toBe(regexReference(page));
    }), { numRuns: 3000 });
  });

  test("through extractText for text/html and application/xhtml+xml", async () => {
    const page = "<h1>Title</h1>\r\n<p>Body &amp; more</p>";
    for (const type of ["text/html", "text/html; charset=utf-8", "application/xhtml+xml"]) expect(await extractText(bytes(page), type)).toBe(regexReference(page.replace(/\r\n/g, "\n")));
  });
});

/** Fastest of a few runs, so a GC pause or a JIT compile is not measured. */
async function fastest(run: () => Promise<unknown>, runs = 5): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < runs; i++) { const started = performance.now(); await run(); best = Math.min(best, performance.now() - started); }
  return best;
}
const settle = (promise: Promise<unknown>) => promise.catch(() => undefined);

describe("intake extraction cost (no super-linear pass on untrusted input)", () => {
  // The reported shapes: 64 KB of "<" took 1.7 s and 390 KB (fits the 1 MiB proxy body) 78 s with the regex extractor.
  const shapes: Record<string, (n: number) => string> = {
    "<": (n) => "<".repeat(n),
    "<p": (n) => "<p".repeat(n / 2),
    "<script": (n) => "<script".repeat(n / 7),
    "<script>": (n) => `${"<script>".repeat(n / 8)}x`,
    "<style then one >": (n) => `${"<style".repeat(n / 6)}>x`,
    "</p and spaces": (n) => `x</p${" ".repeat(n)}`,
    "&# digits": (n) => `&#${"1".repeat(n)}`,
    "&#x hex": (n) => `&#x${"a".repeat(n)}`,
    "\\r\\n": (n) => `x${"\r\n".repeat(n / 2)}`,
    "spaces and tabs": (n) => `x${" \t\f".repeat(n / 3)}x`,
    "<b>x": (n) => "<b>x".repeat(n / 4),
  };

  test("a 390 KB hostile upload extracts in well under a second", async () => {
    for (const [name, make] of Object.entries(shapes)) {
      const doc = bytes(make(390_000));
      await settle(extractText(doc, "text/html"));
      const ms = await fastest(() => settle(extractText(doc, "text/html")));
      expect({ name, fast: ms < 250 }).toEqual({ name, fast: true });
    }
  }, 60_000);

  test("doubling the input at most triples the time", async () => {
    for (const [name, make] of Object.entries(shapes)) {
      for (const type of ["text/html", "text/plain"]) {
        const small = bytes(make(512 * 1024)), large = bytes(make(1024 * 1024));
        await settle(extractText(small, type)); await settle(extractText(large, type));
        const a = await fastest(() => settle(extractText(small, type))), b = await fastest(() => settle(extractText(large, type)));
        expect({ name, type, linear: b <= 3 * a + 5 }).toEqual({ name, type, linear: true });
      }
    }
  }, 60_000);
});

describe("intake extraction bounds", () => {
  test("refuses documents above the input bound before reading them", async () => {
    const pdf = { extract: async () => { throw new Error("must not run"); } };
    for (const type of ["text/html", "text/plain", "application/json", "application/pdf"]) {
      await expect(extractText(new Uint8Array(MAX_DOCUMENT_BYTES + 1), type, pdf)).rejects.toBeInstanceOf(DocumentTooLarge);
    }
  });

  test("refuses extracted text above the text bound, from any format", async () => {
    await expect(extractText(bytes("a".repeat(MAX_TEXT_CHARS + 1)), "text/plain")).rejects.toBeInstanceOf(DocumentTooLarge);
    expect(await extractText(bytes("a".repeat(MAX_TEXT_CHARS)), "text/plain")).toHaveLength(MAX_TEXT_CHARS);
    const pdf = { extract: async () => "p".repeat(MAX_TEXT_CHARS + 1) };
    await expect(extractText(bytes("%PDF"), "application/pdf", pdf)).rejects.toBeInstanceOf(DocumentTooLarge);
  });

  test("refuses a document with no extractable text (nothing for jurors to read or to price)", async () => {
    for (const [doc, type] of [["<b></b>".repeat(50_000), "text/html"], ["<script>x()</script>\n<p> </p>", "text/html"], [" \n\t ", "text/plain"], ["", "application/json"]] as const) {
      const error = await extractText(bytes(doc), type).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmptyDocument);
      expect(error).toMatchObject({ code: "EMPTY_DOCUMENT", status: 422 });
    }
    await expect(extractText(bytes("%PDF"), "application/pdf", { extract: async () => "\n\f\n" })).rejects.toBeInstanceOf(EmptyDocument);
  });
});
