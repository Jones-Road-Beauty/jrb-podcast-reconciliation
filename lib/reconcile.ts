// Core reconciliation logic — matches Ramp bills to Podscale rows and validates

import { getBillsForApproval, getBillInvoiceUrl, type RampBill } from "./ramp";
import { getPodscaleRows, type PodscaleRow } from "./sheets";
import { findMatch, findMatchesForBill } from "./matcher";

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

// Reconcile a single bill into one or more ReconciliationResult rows.
// When a bill has 2+ line items each with their own dollar amount (e.g. an
// Amplitude invoice covering "Were You Raised by Wolves?" $450 + another show
// $360 = $810 total), we match each line item independently and check spend
// against the line item amount — not the invoice total. The previous logic
// either compared the full invoice total to one show's expected spend, or
// evenly split the total across matched rows, both of which produced false
// "Spend mismatch" alerts.
export function reconcileBill(
  bill: RampBill,
  invoiceUrl: string | null,
  podscaleRows: PodscaleRow[]
): ReconciliationResult[] {
  const lineItemsWithAmount = bill.lineItems.filter((li) => li.amount > 0);

  if (lineItemsWithAmount.length >= 2) {
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

  // Single-line or no-line bill: legacy vendor + descriptions matching against
  // the full bill total. This is the common path (most invoices = one show).
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
