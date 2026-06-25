import { NextResponse } from "next/server";
import { getPodscaleRows, type PodscaleRow } from "@/lib/sheets";
import { findMatch, findAllNetworkShows } from "@/lib/matcher";

// Validate a SINGLE bill from Whitney's approval-queue screenshot against
// Podscale, given just a vendor name + invoice amount (no Ramp line items).
//
// Unlike /api/search (which returns one best-match show), this is network-aware:
// many vendors are networks with several shows (Backyard Ventures, Studio 71,
// Dear Media…), so an invoice may equal one show's budget, a MULTIPLE of one
// show (e.g. Headgum $3,360 = 2 × $1,680), or the SUM of several shows that
// aired (a network bundle). We check all three before calling spend a mismatch.
//
// GET /api/validate?vendor=<name>&amount=<dollars>

const SPEND_TOLERANCE = 0.5;

type Status = "APPROVE" | "HOLD" | "UNCERTAIN" | "UNMATCHED";

interface MatchedShow {
  showName: string;
  expectedSpend: number | null;
  aired: boolean;
  podscaleApproved: boolean;
}

function toShow(r: PodscaleRow): MatchedShow {
  return {
    showName: r.showName,
    expectedSpend: r.expectedSpend,
    aired: !!r.airedDate,
    podscaleApproved: r.podscaleApproved,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendor = url.searchParams.get("vendor")?.trim();
  const amount = parseFloat(url.searchParams.get("amount") ?? "");
  if (!vendor || isNaN(amount)) {
    return NextResponse.json({ error: "vendor and numeric amount are required" }, { status: 400 });
  }

  const rows = await getPodscaleRows();

  // All shows under this vendor/network; fall back to the single best match.
  let shows = findAllNetworkShows(vendor, rows);
  let lowConfidence = false;

  if (shows.length === 0) {
    const m = findMatch(vendor, rows);
    if (m) {
      shows = [m.row];
      lowConfidence = m.score > 0.3;
    }
  }

  if (shows.length === 0) {
    return NextResponse.json({
      vendor,
      amount,
      status: "UNMATCHED" as Status,
      network: null,
      matchedShows: [],
      reason: "Not found in Podscale — verify manually",
    });
  }

  const matchedShows = shows.map(toShow);
  const network = shows[0].network || null;
  const airedApproved = matchedShows.filter((s) => s.aired && s.podscaleApproved);
  const withBudget = matchedShows.filter((s) => s.expectedSpend != null);

  // ---- Spend reconciliation (does `amount` correspond to real budget?) ----
  const near = (a: number, b: number) => Math.abs(a - b) <= SPEND_TOLERANCE;
  let spendBasis: string | null = null;

  // a) exact single show
  const single = withBudget.find((s) => near(amount, s.expectedSpend!));
  if (single) spendBasis = `matches ${single.showName} ($${single.expectedSpend!.toLocaleString()})`;

  // b) integer multiple of a single show (multi-month / multi-spot, same show)
  if (!spendBasis) {
    const mult = withBudget.find((s) => {
      const n = amount / s.expectedSpend!;
      return s.expectedSpend! > 0 && n >= 2 && Math.abs(n - Math.round(n)) < 0.01;
    });
    if (mult) {
      const n = Math.round(amount / mult.expectedSpend!);
      spendBasis = `${n} × ${mult.showName} ($${mult.expectedSpend!.toLocaleString()}) — confirm ${n} shows/months`;
    }
  }

  // c) bundle: sum of all aired+approved shows for the network
  if (!spendBasis && airedApproved.length >= 2) {
    const sum = airedApproved.reduce((s, x) => s + (x.expectedSpend ?? 0), 0);
    if (near(amount, sum)) {
      spendBasis = `bundle of ${airedApproved.length} aired shows (sum $${sum.toLocaleString()})`;
    }
  }

  // ---- Aired / approved status of the relevant show(s) ----
  const anyAired = matchedShows.some((s) => s.aired);
  const anyApproved = matchedShows.some((s) => s.podscaleApproved);
  const relevantAired = single || airedApproved.length >= 2 ? true : anyAired;

  const reasons: string[] = [];
  if (lowConfidence) reasons.push(`Low-confidence match to "${shows[0].showName}" — confirm show`);
  if (!spendBasis) {
    const opts = withBudget.map((s) => `${s.showName} $${(s.expectedSpend ?? 0).toLocaleString()}`).slice(0, 4);
    reasons.push(
      `Spend $${amount.toLocaleString()} doesn't match Podscale${opts.length ? ` (shows: ${opts.join(", ")})` : ""}`
    );
  }
  if (!anyAired) reasons.push("No matched show marked aired (Col R blank)");
  if (!anyApproved) reasons.push("Not Podscale-approved (Col S not TRUE)");

  let status: Status;
  if (lowConfidence && !spendBasis) status = "UNCERTAIN";
  else if (spendBasis && relevantAired && anyApproved) status = "APPROVE";
  else status = "HOLD";

  return NextResponse.json({
    vendor,
    amount,
    status,
    network,
    matchedShows,
    spendBasis,
    reason: reasons.join("; ") || spendBasis,
    reasons,
  });
}
