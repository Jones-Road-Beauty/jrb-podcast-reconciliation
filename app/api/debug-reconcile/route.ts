// Temporary: dry-run reconcileBill against a single bill ID and return
// intermediate values for debugging. Delete after diagnosing.
import { NextResponse } from "next/server";
import { getBillById } from "@/lib/ramp";
import { getPodscaleRows } from "@/lib/sheets";
import { findAllNetworkShows } from "@/lib/matcher";
import { reconcileBill } from "@/lib/reconcile";

export const maxDuration = 60;

export async function GET(req: Request) {
  const billId = new URL(req.url).searchParams.get("billId");
  if (!billId) return NextResponse.json({ error: "billId required" }, { status: 400 });

  const [bill, rows] = await Promise.all([getBillById(billId), getPodscaleRows()]);
  if (!bill) return NextResponse.json({ error: "bill not found" }, { status: 404 });

  const networkShows = findAllNetworkShows(bill.vendor, rows);

  // Same filter logic as tryNetworkBundle, exposed for inspection
  const billDate = bill.invoiceDate ? new Date(bill.invoiceDate) : null;
  const billDateValid = billDate && !isNaN(billDate.getTime());
  const billMonth = billDateValid ? billDate.getMonth() : null;
  const billYear = billDateValid ? billDate.getFullYear() : null;

  function parseAired(s: string | null): { raw: string | null; parsed: string | null; month: number | null; year: number | null } {
    if (!s) return { raw: null, parsed: null, month: null, year: null };
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return { raw: s, parsed: null, month: null, year: null };
    const d = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
    return { raw: s, parsed: d.toISOString(), month: d.getMonth(), year: d.getFullYear() };
  }

  function inBillingMonth(am: number | null, ay: number | null): boolean {
    if (am === null || ay === null || billMonth === null || billYear === null) return false;
    if (ay === billYear && am === billMonth) return true;
    const prevM = billMonth === 0 ? 11 : billMonth - 1;
    const prevY = billMonth === 0 ? billYear - 1 : billYear;
    return ay === prevY && am === prevM;
  }

  const networkBreakdown = networkShows.map((r) => {
    const parsed = parseAired(r.airedDate);
    return {
      rowNumber: r.rowNumber,
      showName: r.showName,
      network: r.network,
      expectedSpend: r.expectedSpend,
      airedRaw: r.airedDate,
      airedParsed: parsed.parsed,
      podscaleApproved: r.podscaleApproved,
      passesExpectedSpend: r.expectedSpend != null,
      passesApproved: r.podscaleApproved,
      passesAiredParsed: parsed.parsed !== null,
      passesInBillingMonth: inBillingMonth(parsed.month, parsed.year),
      isCandidate:
        r.expectedSpend != null &&
        r.podscaleApproved &&
        parsed.parsed !== null &&
        inBillingMonth(parsed.month, parsed.year),
    };
  });

  const candidates = networkBreakdown.filter((r) => r.isCandidate);
  const candidatesSum = candidates.reduce((s, r) => s + (r.expectedSpend ?? 0), 0);

  const results = reconcileBill(bill, null, rows);

  return NextResponse.json({
    bill: {
      id: bill.id,
      vendor: bill.vendor,
      invoiceDate: bill.invoiceDate,
      billDateParsed: billDateValid ? billDate.toISOString() : null,
      billMonth,
      billYear,
      totalAmount: bill.totalAmount,
      lineItems: bill.lineItems,
    },
    networkShowsTotal: networkShows.length,
    candidatesCount: candidates.length,
    candidatesSum,
    sumMatchesTotal: Math.abs(candidatesSum - bill.totalAmount) <= 0.5,
    candidates,
    nonCandidates: networkBreakdown.filter((r) => !r.isCandidate).slice(0, 5),
    reconciledResults: results.map((r) => ({
      status: r.status,
      billVendor: r.billVendor,
      billAmount: r.billAmount,
      matchedShow: r.matchedRow?.showName,
      matchedOn: r.matchedOn,
    })),
  });
}
