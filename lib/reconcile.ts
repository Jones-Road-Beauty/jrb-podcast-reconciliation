// Core reconciliation logic — matches Ramp bills to Podscale rows and validates

import { getBillsForApproval, getBillInvoiceUrl, type RampBill } from "./ramp";
import { getPodscaleRows, type PodscaleRow } from "./sheets";
import { findMatch, findMatchesForBill, findAllNetworkShows } from "./matcher";

export type ReconciliationStatus = "APPROVE" | "FLAG" | "UNMATCHED";

export interface ReconciliationChecks {
  aired: boolean;
  podscaleApproved: boolean;
  spendMatches: boolean;
}

export interface ReconciliationResult {
  status: ReconciliationStatus;
  billId: string;
  billVendor: string;
  billAmount: number;
  billInvoiceUrl: string | null;
  matchedRow: PodscaleRow | null;
  checks: ReconciliationChecks;
  matchScore: number | null; // 0 = perfect
  matchedOn: string | null;
}

// Allow up to $0.50 difference for rounding
const SPEND_TOLERANCE = 0.5;

function reconcileBillAgainstRow(
  bill: RampBill,
  row: PodscaleRow,
  invoiceUrl: string | null,
  matchScore: number,
  matchedOn: string
): ReconciliationResult {
  const aired = !!row.airedDate;
  const podscaleApproved = row.podscaleApproved;
  const spendMatches =
    row.expectedSpend === null
      ? true // can't check if budget not set
      : Math.abs(bill.totalAmount - row.expectedSpend) <= SPEND_TOLERANCE;

  const checks: ReconciliationChecks = { aired, podscaleApproved, spendMatches };
  const allPass = aired && podscaleApproved && spendMatches;

  return {
    status: allPass ? "APPROVE" : "FLAG",
    billId: bill.id,
    billVendor: bill.vendor,
    billAmount: bill.totalAmount,
    billInvoiceUrl: invoiceUrl,
    matchedRow: row,
    checks,
    matchScore,
    matchedOn,
  };
}

// Podscale sheet stores aired dates as "M/D/YYYY"
function parseAiredDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

// Bill date used as the reference for "billing month". Falls back through
// invoice_date → due_date → created_at depending on what Ramp populated.
function parseBillDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// True if `airedDate` falls in the same calendar month as `billDate` or
// the immediately preceding month. Most podcast invoices are net-30 for
// the prior month's airings (e.g. May 6 invoice = April airings), so this
// window catches both same-month and prior-month cases.
function isInBillingMonth(airedDate: Date, billDate: Date): boolean {
  const billY = billDate.getFullYear();
  const billM = billDate.getMonth();
  const airedY = airedDate.getFullYear();
  const airedM = airedDate.getMonth();
  if (airedY === billY && airedM === billM) return true;
  // Previous month, including December → January rollover
  const prevM = billM === 0 ? 11 : billM - 1;
  const prevY = billM === 0 ? billY - 1 : billY;
  return airedY === prevY && airedM === prevM;
}

// When a bill's vendor is a network (Amplitude, Dear Media, etc.) that
// represents multiple shows, Ramp typically receives a single aggregated
// amount with no per-show breakdown. This helper sums expected spend across
// all of that network's aired+approved shows in the billing month and, if
// the sum matches the invoice total, emits one APPROVE result per show.
// Returns null if no clean bundle match — caller falls back to legacy path.
function tryNetworkBundle(
  bill: RampBill,
  invoiceUrl: string | null,
  podscaleRows: PodscaleRow[]
): ReconciliationResult[] | null {
  const networkShows = findAllNetworkShows(bill.vendor, podscaleRows);
  if (networkShows.length < 2) return null;

  const billDate = parseBillDate(bill.invoiceDate);
  if (!billDate) return null;

  const candidates = networkShows.filter((r) => {
    if (r.expectedSpend == null) return false;
    if (!r.podscaleApproved) return false;
    const aired = parseAiredDate(r.airedDate);
    if (!aired) return false;
    return isInBillingMonth(aired, billDate);
  });

  if (candidates.length < 2) return null;

  const sum = candidates.reduce((s, r) => s + (r.expectedSpend ?? 0), 0);
  if (Math.abs(sum - bill.totalAmount) > SPEND_TOLERANCE) return null;

  // Bundle matches — emit one APPROVE result per show, each carrying its
  // own expected spend as `billAmount` so Slack shows per-show numbers.
  return candidates.map((row) => ({
    status: "APPROVE" as const,
    billId: bill.id,
    billVendor: `${bill.vendor} — ${row.showName}`,
    billAmount: row.expectedSpend!,
    billInvoiceUrl: invoiceUrl,
    matchedRow: row,
    checks: { aired: true, podscaleApproved: true, spendMatches: true },
    matchScore: 0,
    matchedOn: "network",
  }));
}

// Reconcile a single bill into one or more ReconciliationResult rows.
// Order of attempts:
//   1. Real per-line-item breakdown (2+ non-zero line items): match each LI
//      against Podscale using its own amount.
//   2. Network-bundle: vendor maps to a network with 2+ aired shows in the
//      billing month whose expected-spend sum equals the invoice total
//      (e.g. Amplitude $810 = Wolves $450 + Brooke Ashley $360, both 4/27).
//   3. Legacy single-vendor matching against the full bill total.
export function reconcileBill(
  bill: RampBill,
  invoiceUrl: string | null,
  podscaleRows: PodscaleRow[]
): ReconciliationResult[] {
  const lineItemsWithAmount = bill.lineItems.filter((li) => li.amount > 0);
  const lineItemsSum = lineItemsWithAmount.reduce((s, li) => s + li.amount, 0);

  // Real per-LI breakdown only when there are 2+ items AND they don't all
  // fold into a single line that equals the invoice total (a common Ramp
  // pattern where "line items" are NetSuite GL coding rows, not real
  // per-show splits). Treat as real per-LI breakdown only when the sum of
  // line items roughly matches the bill total but no single line item is
  // the whole bill.
  const hasRealPerLineBreakdown =
    lineItemsWithAmount.length >= 2 &&
    Math.abs(lineItemsSum - bill.totalAmount) <= SPEND_TOLERANCE &&
    !lineItemsWithAmount.some((li) => Math.abs(li.amount - bill.totalAmount) <= SPEND_TOLERANCE);

  if (hasRealPerLineBreakdown) {
    return lineItemsWithAmount.map((li) => {
      const m = findMatch(li.description, podscaleRows);
      const vendorLabel = `${bill.vendor} — ${li.description}`.trim();
      const syntheticBill: RampBill = { ...bill, totalAmount: li.amount };
      if (m) {
        const r = reconcileBillAgainstRow(
          syntheticBill,
          m.row,
          invoiceUrl,
          m.score,
          m.matchedOn
        );
        return { ...r, billVendor: vendorLabel };
      }
      return {
        status: "UNMATCHED",
        billId: bill.id,
        billVendor: vendorLabel,
        billAmount: li.amount,
        billInvoiceUrl: invoiceUrl,
        matchedRow: null,
        checks: { aired: false, podscaleApproved: false, spendMatches: false },
        matchScore: null,
        matchedOn: null,
      };
    });
  }

  const bundle = tryNetworkBundle(bill, invoiceUrl, podscaleRows);
  if (bundle) return bundle;

  // Legacy: vendor + descriptions matching against the full bill total.
  const lineItemDescs = bill.lineItems.map((li) => li.description);
  const matches = findMatchesForBill(bill.vendor, lineItemDescs, podscaleRows);

  if (matches.length === 0) {
    return [{
      status: "UNMATCHED",
      billId: bill.id,
      billVendor: bill.vendor,
      billAmount: bill.totalAmount,
      billInvoiceUrl: invoiceUrl,
      matchedRow: null,
      checks: { aired: false, podscaleApproved: false, spendMatches: false },
      matchScore: null,
      matchedOn: null,
    }];
  }

  return matches.map((m) =>
    reconcileBillAgainstRow(bill, m.row, invoiceUrl, m.score, m.matchedOn)
  );
}

export async function runReconciliation(): Promise<ReconciliationResult[]> {
  const [bills, podscaleRows] = await Promise.all([
    getBillsForApproval(),
    getPodscaleRows(),
  ]);

  // Fetch every invoice URL in parallel — the serial version was the main
  // reason a 20-bill queue hit the 60s function timeout.
  const invoiceUrls = await Promise.all(
    bills.map((b) => getBillInvoiceUrl(b.id).catch(() => null))
  );

  const results: ReconciliationResult[] = [];
  for (let i = 0; i < bills.length; i++) {
    results.push(...reconcileBill(bills[i], invoiceUrls[i], podscaleRows));
  }

  // Sort: APPROVE first, then FLAG, then UNMATCHED
  const order: ReconciliationStatus[] = ["APPROVE", "FLAG", "UNMATCHED"];
  results.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return results;
}
