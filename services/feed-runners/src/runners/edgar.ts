import { SchemaId } from "@mochi/core";
import type { FeedsConfig } from "../config.ts";
import type { EdgarFiling, FeedJob, RunnerState } from "../ports.ts";
import { alreadyDone, makeJob, subjectKey } from "./common.ts";

function xmlText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? "";
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  }).trim();
}
function tag(entry: string, name: string): string {
  const match = entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? xmlText(match[1]!) : "";
}

/** Parse SEC's Atom response without a DOM dependency. */
export function parseEdgarAtom(xml: string): EdgarFiling[] {
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].flatMap(([, body]) => {
    const id = tag(body!, "id");
    const accession = id.match(/(?:accession-number=|accession-number\/)(\d{10}-\d{2}-\d{6})/i)?.[1]
      ?? id.match(/(\d{10}-\d{2}-\d{6})/)?.[1] ?? "";
    const filingDate = tag(body!, "filing-date") || tag(body!, "updated").slice(0, 10);
    if (!accession || !filingDate) return [];
    return [{ id, accession, filingDate, summary: tag(body!, "summary") }];
  });
}

/**
 * Picks the press-release exhibit from a filing's `{accession}-index.htm` page (SEC "Document Format Files" table:
 * Seq | Description | Document | Type | Size). EX-99.1 preferred, else the first EX-99.x .htm/.html/.txt.
 * Note: EDGAR's index.json does NOT carry document types (its `type` field is an icon name), so the HTML is used.
 */
export function selectPressRelease(indexHtml: string): string | undefined {
  const table = indexHtml.slice(Math.max(0, indexHtml.indexOf("tableFile")));
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => row!);
  const exhibits: { name: string; type: string }[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(([, cell]) => xmlText(cell!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    const href = row.match(/href="([^"]+)"/i)?.[1];
    const type = (cells[3] ?? "").toUpperCase();
    const name = href?.split("/").pop()?.split("?")[0] ?? "";
    if (/^EX-99(\.\d+)?$/.test(type) && /\.(?:htm|html|txt)$/i.test(name)) exhibits.push({ name, type });
  }
  return (exhibits.find((e) => e.type === "EX-99.1") ?? exhibits[0])?.name;
}

type EdgarCompany = NonNullable<FeedsConfig["earnings"]["edgar"]>["companies"][number];
export function makeEdgarJob(company: EdgarCompany, filing: EdgarFiling, url: string, state: RunnerState): FeedJob | undefined {
  const key = `${company.ticker.toUpperCase()}:${filing.accession}`;
  const id = `earnings:edgar:${key}`;
  if (alreadyDone(state, id)) return undefined;
  const params: Record<string, unknown> = {};
  if (company.consensus_eps !== undefined) params.consensus_eps = company.consensus_eps;
  if (company.consensus_revenue !== undefined) params.consensus_revenue = company.consensus_revenue;
  if (company.consensus_eps_basis !== undefined) params.consensus_eps_basis = company.consensus_eps_basis;
  return makeJob({ runner: "earnings", id, schemaId: SchemaId.EARNINGS, n: 7, feedName: "earnings@RHC", key: subjectKey(company.ticker.toUpperCase()), url, params });
}
