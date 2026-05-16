// Core reconciliation logic — matches Ramp bills to Podscale rows and validates

import { getBillsForApproval, getBillInvoiceUrl, type RampBill } from "./ramp";
import { getPodscaleRows, type PodscaleRow } from "./sheets";
import { findMatchesForBill } from "./matcher";

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
    const bill = bills[i];
    const invoiceUrl = invoiceUrls[i];
    const lineItemDescs = bill.lineItems.map((li) => li.description);
    const matches = findMatchesForBill(bill.vendor, lineItemDescs, podscaleRows);

    if (matches.length === 0) {
      // No match found
      results.push({
        status: "UNMATCHED",
        billId: bill.id,
        billVendor: bill.vendor,
        billAmount: bill.totalAmount,
        billInvoiceUrl: invoiceUrl,
        matchedRow: null,
        checks: { aired: false, podscaleApproved: false, spendMatches: false },
        matchScore: null,
        matchedOn: null,
      });
    } else if (matches.length === 1) {
      // Single show matched
      const m = matches[0];
      results.push(
        reconcileBillAgainstRow(bill, m.row, invoiceUrl, m.score, m.matchedOn)
      );
    } else {
      // Multi-show invoice — validate each matched show row separately
      // For spend check, split bill amount evenly across matched rows
      const splitAmount = bill.totalAmount / matches.length;
      for (const m of matches) {
        const syntheticBill: RampBill = { ...bill, totalAmount: splitAmount };
        results.push(
          reconcileBillAgainstRow(syntheticBill, m.row, invoiceUrl, m.score, m.matchedOn)
        );
      }
    }
  }

  // Sort: APPROVE first, then FLAG, then UNMATCHED
  const order: ReconciliationStatus[] = ["APPROVE", "FLAG", "UNMATCHED"];
  results.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return results;
}
