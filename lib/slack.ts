// Slack notifier — posts reconciliation summary to #podcast-invoices
import { IncomingWebhook } from "@slack/webhook";
import type { ReconciliationResult } from "./reconcile";
import type { RampBill } from "./ramp";

function getWebhook(): IncomingWebhook {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL is not set");
  return new IncomingWebhook(url);
}

function formatDollars(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function checkMark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

export async function postReconciliationSummary(
  results: ReconciliationResult[],
  runDate: string
): Promise<void> {
  const webhook = getWebhook();

  const approved = results.filter((r) => r.status === "APPROVE");
  const flagged = results.filter((r) => r.status === "FLAG");
  const unmatched = results.filter((r) => r.status === "UNMATCHED");

  const lines: string[] = [
    `*📊 Podcast Invoice Reconciliation — ${runDate}*`,
    `${results.length} bill${results.length !== 1 ? "s" : ""} checked`,
    "",
  ];

  if (approved.length > 0) {
    lines.push(`*✅ Ready to approve (${approved.length})*`);
    for (const r of approved) {
      const matchInfo = r.matchedRow
        ? `${r.matchedRow.showName}${r.matchedRow.network ? ` / ${r.matchedRow.network}` : ""}`
        : r.billVendor;
      lines.push(
        `  • ${matchInfo} — ${formatDollars(r.billAmount)}  ` +
        `${checkMark(r.checks.aired)} aired  ` +
        `${checkMark(r.checks.podscaleApproved)} Podscale  ` +
        `${checkMark(r.checks.spendMatches)} spend`
      );
    }
    lines.push("");
  }

  if (flagged.length > 0) {
    lines.push(`*⚠️ Needs review (${flagged.length})*`);
    for (const r of flagged) {
      const label = r.matchedRow?.showName ?? r.billVendor;
      lines.push(`  • *${label}* — ${formatDollars(r.billAmount)}`);
      if (!r.checks.aired) lines.push(`    ↳ ❌ Not marked as aired yet (Col R is blank)`);
      if (!r.checks.podscaleApproved)
        lines.push(`    ↳ ❌ Not marked as Podscale-approved (Col S is not TRUE)`);
      if (!r.checks.spendMatches && r.matchedRow?.expectedSpend != null) {
        lines.push(
          `    ↳ ❌ Spend mismatch: ${formatDollars(r.billAmount)} vs expected ${formatDollars(r.matchedRow.expectedSpend)}`
        );
      }
      if (r.billInvoiceUrl) lines.push(`    ↳ 🔗 <${r.billInvoiceUrl}|View invoice>`);
    }
    lines.push("");
  }

  if (unmatched.length > 0) {
    // Only surface unmatched bills that look like they could be podcast-related.
    // Bills from packaging companies, tech vendors, etc. are noise for Whitney.
    const podcastKeywords = [
      "podcast", "media", "network", "audio", "radio", "studio", "studios",
      "entertainment", "productions", "cast", "stories", "sound",
    ];
    const podcastUnmatched = unmatched.filter((r) => {
      const v = r.billVendor.toLowerCase();
      return podcastKeywords.some((k) => v.includes(k));
    });
    const otherCount = unmatched.length - podcastUnmatched.length;

    if (podcastUnmatched.length > 0) {
      lines.push(`*❓ No spreadsheet match found (${podcastUnmatched.length})*`);
      for (const r of podcastUnmatched) {
        lines.push(`  • "${r.billVendor}" — ${formatDollars(r.billAmount)} — no matching row found`);
        if (r.billInvoiceUrl) lines.push(`    ↳ 🔗 <${r.billInvoiceUrl}|View invoice>`);
      }
      lines.push("");
    }
    if (otherCount > 0) {
      lines.push(`_${otherCount} non-podcast bill${otherCount !== 1 ? "s" : ""} excluded (not in Podscale sheet)_`);
      lines.push("");
    }
  }

  if (results.length === 0) {
    lines.push("_No pending bills found in Ramp._");
  }

  await webhook.send({ text: lines.join("\n") });
}

// Single-bill message posted via the Ramp webhook.
// `results` is the output of `reconcileBill(bill, ...)` — one row per matched
// line item (multi-show invoice) or one row per matched show (single-line bill).
// Each result already carries the correct per-line-item or full-invoice amount,
// so we just render whatever spend value is on the result.
export async function postSingleBillResult(
  bill: RampBill,
  results: ReconciliationResult[],
  runDate: string
): Promise<void> {
  const webhook = getWebhook();
  const lines: string[] = [];

  const allUnmatched = results.every((r) => r.status === "UNMATCHED");

  if (results.length === 0 || allUnmatched) {
    lines.push(`*🎙️ New podcast invoice — ${runDate}*`);
    lines.push(`*"${bill.vendor}"* — ${formatDollars(bill.totalAmount)}`);
    lines.push("");
    lines.push("❓ No matching row found in the Podscale sheet.");
    lines.push("_Check the Master tab manually before approving._");
    if (bill.invoiceUrl) {
      lines.push("");
      lines.push(`🔗 <${bill.invoiceUrl}|View invoice>`);
    }
  } else {
    const allPass = results.every((r) => r.status === "APPROVE");
    const emoji = allPass ? "✅" : "⚠️";
    const statusLabel = allPass ? "Ready to approve" : "Needs review";

    lines.push(`*🎙️ New podcast invoice — ${runDate}*`);
    lines.push(`${emoji} *${statusLabel}*`);
    lines.push(`*${bill.vendor}* — ${formatDollars(bill.totalAmount)}`);
    lines.push("");

    for (const r of results) {
      const label = r.matchedRow
        ? `${r.matchedRow.showName}${r.matchedRow.network ? ` / ${r.matchedRow.network}` : ""}`
        : r.billVendor;
      lines.push(`  • *${label}* — ${formatDollars(r.billAmount)}`);
      if (r.status === "UNMATCHED") {
        lines.push(`    ↳ ❓ No matching row found in the Podscale sheet`);
        continue;
      }
      if (!r.checks.aired) lines.push(`    ↳ ❌ Not marked as aired yet (Col R blank)`);
      if (!r.checks.podscaleApproved)
        lines.push(`    ↳ ❌ Not Podscale-approved (Col S not TRUE)`);
      if (!r.checks.spendMatches && r.matchedRow?.expectedSpend != null) {
        lines.push(
          `    ↳ ❌ Spend mismatch: line item ${formatDollars(r.billAmount)} vs expected ${formatDollars(r.matchedRow.expectedSpend)}`
        );
      }
      if (r.status === "APPROVE") {
        lines.push(
          `    ↳ ${checkMark(r.checks.aired)} aired  ${checkMark(r.checks.podscaleApproved)} Podscale  ${checkMark(r.checks.spendMatches)} spend`
        );
      }
    }

    if (bill.invoiceUrl) {
      lines.push("");
      lines.push(`🔗 <${bill.invoiceUrl}|View invoice>`);
    }
  }

  await webhook.send({ text: lines.join("\n") });
}
