import { NextResponse } from "next/server";
import { runReconciliation } from "@/lib/reconcile";
import { postReconciliationSummary } from "@/lib/slack";

// Reconcile sweeps the whole company-wide PENDING approval queue (~200
// bills today), which paginates through Ramp serially before we can do
// any matching work. 60s isn't enough; 300s is the Vercel default on Pro.
export const maxDuration = 300;

export async function GET(req: Request) {
  // Protect against unauthorized calls in production
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // TEMPORARY: ?dump=bills returns raw status fields for every PENDING bill,
  // grouped by approval_status + payment_status, to diagnose queue-size mismatch.
  if (new URL(req.url).searchParams.get("dump") === "bills") {
    const { getBillsDebugInfo } = await import("@/lib/ramp");
    const bills = (await getBillsDebugInfo()) as Array<Record<string, unknown>>;
    const byApproval: Record<string, number> = {};
    const byPayment: Record<string, number> = {};
    for (const b of bills) {
      const a = String(b.approval_status);
      const p = String(b.payment_status);
      byApproval[a] = (byApproval[a] ?? 0) + 1;
      byPayment[p] = (byPayment[p] ?? 0) + 1;
    }
    return NextResponse.json({ total: bills.length, byApproval, byPayment, bills });
  }

  // ?diag=1 runs step-by-step with per-step errors for debugging
  const diag = new URL(req.url).searchParams.get("diag") === "1";
  if (diag) {
    const { getBillsForApproval } = await import("@/lib/ramp");
    const { getPodscaleRows } = await import("@/lib/sheets");
    const steps: Record<string, unknown> = {};
    try { const b = await getBillsForApproval(); steps.ramp = `ok — ${b.length} bills`; } catch (e) { steps.ramp = `ERROR: ${e instanceof Error ? e.message : e}`; }
    try { const r = await getPodscaleRows(); steps.sheets = `ok — ${r.length} rows`; } catch (e) { steps.sheets = `ERROR: ${e instanceof Error ? e.message : e}`; }
    return NextResponse.json({ diag: true, steps });
  }

  try {
    const results = await runReconciliation();
    const runDate = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "America/New_York",
    });

    await postReconciliationSummary(results, runDate);

    const summary = {
      total: results.length,
      approve: results.filter((r) => r.status === "APPROVE").length,
      flag: results.filter((r) => r.status === "FLAG").length,
      unmatched: results.filter((r) => r.status === "UNMATCHED").length,
      runDate,
    };

    return NextResponse.json({ ok: true, summary, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconcile] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
