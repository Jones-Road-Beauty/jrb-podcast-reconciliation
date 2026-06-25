import { NextResponse } from "next/server";
import { getBillsForApproval, getBillInvoiceUrl } from "@/lib/ramp";

// Return the Ramp invoice-document URL(s) for pending bills matching a vendor.
// Used by the podcast-queue-check skill to read the actual invoice PDF and pull
// the specific show name(s) — networks (Backyard Ventures, Studio 71, Dear
// Media) bundle several shows, so the vendor + amount alone can't pin the show.
//
// GET /api/invoices?vendor=<substring>&amount=<dollars, optional>

export const maxDuration = 120;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendor = url.searchParams.get("vendor")?.trim();
  const amountParam = url.searchParams.get("amount");
  const amount = amountParam ? parseFloat(amountParam) : null;
  if (!vendor) {
    return NextResponse.json({ error: "vendor is required" }, { status: 400 });
  }

  const bills = await getBillsForApproval();
  const v = norm(vendor);

  let matches = bills.filter((b) => {
    const bv = norm(b.vendor);
    return bv.includes(v) || v.includes(bv);
  });
  if (amount != null && !isNaN(amount)) {
    const exact = matches.filter((b) => Math.abs(b.totalAmount - amount) <= 0.5);
    if (exact.length > 0) matches = exact;
  }

  const results = await Promise.all(
    matches.map(async (b) => ({
      billId: b.id,
      vendor: b.vendor,
      amount: b.totalAmount,
      invoiceDate: b.invoiceDate,
      invoiceUrl: await getBillInvoiceUrl(b.id).catch(() => null),
    }))
  );

  return NextResponse.json({ vendor, amount, count: results.length, bills: results });
}
