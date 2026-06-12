// Fuzzy name matcher: maps Ramp bill vendor/line-item names → Podscale rows
// Uses Fuse.js with a multi-field fallback strategy

import Fuse from "fuse.js";
import type { PodscaleRow } from "./sheets";

export interface MatchResult {
  row: PodscaleRow;
  score: number;       // 0 = perfect, 1 = worst
  matchedOn: "showName" | "network";
  method: "exact" | "fuzzy";
}

// Threshold: 0 = perfect match required, 1 = match anything.
// 0.4 catches common abbreviations and partial name differences.
const FUZZY_THRESHOLD = 0.4;

// Known vendor abbreviations used in the Podscale sheet
// key = normalized sheet network name, values = normalized Ramp vendor substrings
const NETWORK_ALIASES: Record<string, string[]> = {
  "sxm": ["sirius xm"],
  "meidas touch": ["meidas media"],
  "law & crime": ["lawnewz", "law crime"],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip common legal/company suffixes so "Acast Stories Inc" → "Acast",
// "Sony Music Entertainment" → "Sony", etc.
function stripSuffixes(s: string): string {
  return s
    .replace(/\b(llc|inc\.?|ltd\.?|corp\.?|group|media|entertainment|stories|music|network|ventures|partners|productions|studios|sales|services)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Check alias map: returns true if vendor matches a known alias for the given network
function aliasMatch(vendorNorm: string, networkNorm: string): boolean {
  const aliases = NETWORK_ALIASES[networkNorm];
  if (aliases) {
    return aliases.some((alias) => vendorNorm.includes(alias) || alias.includes(vendorNorm));
  }
  // Also check reverse: vendor is the full name, network is the abbreviation
  for (const [net, aliasList] of Object.entries(NETWORK_ALIASES)) {
    if (networkNorm === net && aliasList.some((a) => vendorNorm.includes(a))) return true;
    if (aliasList.includes(networkNorm) && vendorNorm.includes(net)) return true;
  }
  return false;
}

export function findMatch(
  query: string,
  rows: PodscaleRow[]
): MatchResult | null {
  if (!query.trim()) return null;
  const q = normalize(query);
  const qStripped = normalize(stripSuffixes(query));

  // 1. Exact match on show name
  for (const row of rows) {
    if (normalize(row.showName) === q) {
      return { row, score: 0, matchedOn: "showName", method: "exact" };
    }
  }

  // 2. Exact match on network (full or suffix-stripped)
  for (const row of rows) {
    if (!row.network) continue;
    const net = normalize(row.network);
    const netStripped = normalize(stripSuffixes(row.network));
    if (net === q || net === qStripped || netStripped === q || netStripped === qStripped) {
      return { row, score: 0, matchedOn: "network", method: "exact" };
    }
    // Alias check
    if (aliasMatch(q, net) || aliasMatch(qStripped, net)) {
      return { row, score: 0.05, matchedOn: "network", method: "exact" };
    }
  }

  // 3. Fuzzy match on show name (also try suffix-stripped query)
  const showFuse = new Fuse(rows, {
    keys: ["showName"],
    threshold: FUZZY_THRESHOLD,
    includeScore: true,
    getFn: (obj, path) => normalize((obj as unknown as Record<string, string>)[path as string] ?? ""),
  });
  for (const candidate of [q, qStripped]) {
    const showResults = showFuse.search(candidate);
    if (showResults.length > 0 && showResults[0].score !== undefined) {
      return {
        row: showResults[0].item,
        score: showResults[0].score,
        matchedOn: "showName",
        method: "fuzzy",
      };
    }
  }

  // 4. Fuzzy match on network (also try suffix-stripped query)
  const netFuse = new Fuse(
    rows.filter((r) => r.network),
    {
      keys: ["network"],
      threshold: FUZZY_THRESHOLD,
      includeScore: true,
      getFn: (obj, path) => normalize((obj as unknown as Record<string, string>)[path as string] ?? ""),
    }
  );
  for (const candidate of [q, qStripped]) {
    const netResults = netFuse.search(candidate);
    if (netResults.length > 0 && netResults[0].score !== undefined) {
      return {
        row: netResults[0].item,
        score: netResults[0].score,
        matchedOn: "network",
        method: "fuzzy",
      };
    }
  }

  return null;
}

// Gate used to decide whether a Ramp bill is even podcast-related before we
// bother reconciling it. The reconciliation sweep pulls the WHOLE company-wide
// PENDING queue (packaging, insurance, photographers, models, etc.), so we must
// only keep bills whose vendor confidently maps to a Podscale show/network.
//
// This is intentionally STRICTER than findMatch's 0.4 fuzzy threshold: a loose
// fuzzy hit is exactly what produced dozens of false "matches" in Slack. We
// accept only exact/alias matches or a tight fuzzy match.
const PODCAST_VENDOR_THRESHOLD = 0.2;

export function isPodcastVendor(vendor: string, rows: PodscaleRow[]): boolean {
  const m = findMatch(vendor, rows);
  if (!m) return false;
  if (m.method === "exact") return true; // exact show/network or known alias
  return m.score <= PODCAST_VENDOR_THRESHOLD;
}

// Return every Podscale row whose network field matches the query (vendor name).
// Used for "network bundle" reconciliation — many vendors (Amplitude Media
// Partners, Dear Media, etc.) bill one lump sum that covers multiple shows
// they represent, with the per-show breakdown only present on the invoice PDF.
// We can still validate spend by summing expected spend across the network's
// shows that aired in the billing month.
export function findAllNetworkShows(query: string, rows: PodscaleRow[]): PodscaleRow[] {
  if (!query.trim()) return [];
  const q = normalize(query);
  const qStripped = normalize(stripSuffixes(query));

  return rows.filter((r) => {
    if (!r.network) return false;
    const net = normalize(r.network);
    const netStripped = normalize(stripSuffixes(r.network));
    if (net === q || net === qStripped || netStripped === q || netStripped === qStripped) {
      return true;
    }
    return aliasMatch(q, net) || aliasMatch(qStripped, net);
  });
}

// For a bill with multiple line items, try matching each line item description
// and also the vendor name. Return all unique matches found.
export function findMatchesForBill(
  vendor: string,
  lineItemDescriptions: string[],
  rows: PodscaleRow[]
): MatchResult[] {
  const seen = new Set<number>(); // rowNumber
  const results: MatchResult[] = [];

  const candidates = [vendor, ...lineItemDescriptions].filter(Boolean);

  for (const candidate of candidates) {
    const match = findMatch(candidate, rows);
    if (match && !seen.has(match.row.rowNumber)) {
      seen.add(match.row.rowNumber);
      results.push(match);
    }
  }

  return results;
}
