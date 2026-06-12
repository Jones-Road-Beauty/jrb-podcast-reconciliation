import { NextResponse } from "next/server";
import { getBillById, getBillInvoiceUrl, getAccessTokenPublic } from "@/lib/ramp";
import { getPodscaleRows } from "@/lib/sheets";
import { reconcileBill } from "@/lib/reconcile";
import { isPodcastVendor } from "@/lib/matcher";
import { postSingleBillResult } from "@/lib/slack";

const RAMP_API_BASE = "https://api.ramp.com/developer/v1";

// Find the pending webhook for our own endpoint URL, then call /verify.
// We look it up dynamically so we don't need RAMP_WEBHOOK_ID to match exactly.
async function verifyWebhook(challenge: string): Promise<void> {
  const token = await getAccessTokenPublic();
  const ourUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/webhook/ramp`
    : "https://jrb-podcast-reconciliation.vercel.app/api/webhook/ramp";

  // List all webhooks to find ours
  const listRes = await fetch(`${RAMP_API_BASE}/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json() as Array<{ id: string; endpoint_url: string; status: string }>;
  const pending = listData.find(
    (w) => w.endpoint_url === ourUrl && w.status === "pending_verification"
  );

  if (!pending) {
    console.warn("[webhook] no pending webhook found for our URL — already active or URL mismatch");
    return;
  }

  console.log("[webhook] verifying webhook id:", pending.id);
  const res = await fetch(`${RAMP_API_BASE}/webhooks/${pending.id}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ challenge }),
  });
  const data = await res.json();
  console.log("[webhook] verify result:", res.status, JSON.stringify(data));
}

export const maxDuration = 60;

// Ramp's webhook payload shape varies across API versions. Walk every
// reasonable location and return the first bill-id-shaped string we find.
function extractBillId(payload: Record<string, unknown>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  const candidates: unknown[] = [
    p?.object?.resource_id,    // older shape: { type, object: { resource_id } }
    p?.data?.id,               // newer shape: { event_type, data: { id } }
    p?.data?.bill_id,
    p?.data?.resource_id,
    p?.bill?.id,
    p?.bill_id,
    p?.resource_id,
    p?.id,                     // last resort — some payloads use top-level id
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

// Verify Ramp HMAC-SHA256 signature
async function verifySignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle Ramp's challenge handshake BEFORE signature check.
  // The challenge arrives immediately after registration, before we can store
  // the new secret in our deployment — so we allow it through unsigned.
  // Challenges are not security-sensitive (no business data involved).
  // Ramp sends { challenge: "..." } and expects us to:
  //   1. Return 2xx (so they know the endpoint is reachable)
  //   2. Call POST /webhooks/{id}/verify with the challenge to activate
  if (payload.challenge) {
    const challenge = payload.challenge as string;
    console.log("[webhook] challenge received:", challenge);
    // Must await — Vercel terminates function on response, killing async tasks
    await verifyWebhook(challenge);
    return NextResponse.json({ challenge });
  }

  // Log the full payload (truncated) so we can inspect the actual Ramp schema
  const bodyForLog = rawBody.length > 2000 ? rawBody.slice(0, 2000) + "...[truncated]" : rawBody;
  console.log("[webhook] keys:", Object.keys(payload).join(","), "body:", bodyForLog);

  // Verify signature for all real events (not challenge handshakes)
  const webhookSecret = process.env.RAMP_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig = req.headers.get("x-ramp-signature");
    const valid = await verifySignature(rawBody, sig, webhookSecret);
    if (!valid) {
      console.error("[webhook] Invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // Ramp has shipped a few different webhook payload shapes; check all known ones.
  // Always return 200 — if we 4xx, Ramp marks the delivery as failed and may
  // disable the webhook after repeated failures.
  const eventType = (payload.type ?? payload.event_type ?? payload.event) as string | undefined;
  if (eventType && !eventType.startsWith("bills.created")) {
    console.log(`[webhook] ignoring event type: ${eventType}`);
    return NextResponse.json({ ok: true, ignored: true, eventType });
  }

  const billId = extractBillId(payload);
  if (!billId) {
    console.error("[webhook] could not extract bill id from payload — see body above");
    // 200 so Ramp doesn't disable the webhook; we'll diagnose from logs.
    return NextResponse.json({ ok: false, error: "Missing bill id", payloadKeys: Object.keys(payload) });
  }

  console.log(`[webhook] bills.created — billId: ${billId}`);

  // Reconcile the single bill and post to Slack
  try {
    const [bill, podscaleRows] = await Promise.all([
      getBillById(billId),
      getPodscaleRows(),
    ]);

    if (!bill) {
      console.warn(`[webhook] Bill ${billId} not found in Ramp`);
      return NextResponse.json({ ok: true, skipped: "bill not found" });
    }

    // Skip non-podcast bills silently — the webhook fires for every Ramp bill,
    // but this Flow only cares about podcast vendors. Without this gate, a
    // packaging/insurance/photographer invoice would post a "no match" message.
    if (!isPodcastVendor(bill.vendor, podscaleRows)) {
      console.log(`[webhook] skipping non-podcast vendor: ${bill.vendor}`);
      return NextResponse.json({ ok: true, skipped: "not a podcast vendor", vendor: bill.vendor });
    }

    const invoiceUrl = await getBillInvoiceUrl(bill.id).catch(() => null);
    // Multi-show invoices (e.g. Amplitude billing $450 Wolves + $360 Brooke
    // Ashley = $810 total) are reconciled per line item so spend checks
    // compare each show against its own line item amount, not the invoice total.
    const results = reconcileBill(bill, invoiceUrl, podscaleRows);

    const runDate = new Date().toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      timeZone: "America/New_York",
    });

    await postSingleBillResult(bill, results, runDate);

    return NextResponse.json({ ok: true, billId, resultCount: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[webhook] Error:", message);
    // Return 200 so Ramp doesn't retry — we'll see the error in logs
    return NextResponse.json({ ok: false, error: message });
  }
}
