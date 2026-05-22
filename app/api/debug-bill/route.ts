// Temporary debug endpoint: inspect raw Ramp bills payload to diagnose
// whether line item amounts are being returned. Delete after diagnosing.
import { NextResponse } from "next/server";
import { getAccessTokenPublic } from "@/lib/ramp";

const RAMP_API_BASE = "https://api.ramp.com/developer/v1";

export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendor = url.searchParams.get("vendor")?.toLowerCase() ?? "amplitude";
  const billId = url.searchParams.get("billId");

  const token = await getAccessTokenPublic();
  const headers = { Authorization: `Bearer ${token}` };

  if (billId) {
    const res = await fetch(`${RAMP_API_BASE}/bills/${billId}`, { headers });
    const raw = await res.json();
    return NextResponse.json({ mode: "byId", billId, raw });
  }

  // List pending bills, filter by vendor substring
  const listRes = await fetch(`${RAMP_API_BASE}/bills?approval_status=PENDING&limit=50`, {
    headers,
  });
  const list = await listRes.json();
  const bills = (list.data ?? []) as Array<Record<string, unknown>>;
  const matching = bills.filter((b) => {
    const v = (b.vendor_name ?? (b.vendor as Record<string, unknown>)?.name ?? b.memo ?? "")
      .toString()
      .toLowerCase();
    return v.includes(vendor);
  });
  return NextResponse.json({
    mode: "list",
    vendorFilter: vendor,
    matchCount: matching.length,
    bills: matching,
  });
}
