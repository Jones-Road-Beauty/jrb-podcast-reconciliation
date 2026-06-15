// Ramp REST API client — OAuth 2.0 client credentials flow
// Docs: https://docs.ramp.com/developer-api/v1

const RAMP_API_BASE = "https://api.ramp.com/developer/v1";
const RAMP_TOKEN_URL = "https://api.ramp.com/developer/v1/token";

export interface RampLineItem {
  description: string;
  amount: number; // in dollars
}

export interface RampBill {
  id: string;
  vendor: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  issuedAt: string | null; // when the invoice was issued — used for cycle filtering
  totalAmount: number; // in dollars
  lineItems: RampLineItem[];
  glCodes: string[]; // GL account external codes (e.g. "6513" = Podcast) on bill + line items
  approvalStatus: string;
  invoiceUrl: string | null;
}

// Collect the GL-account external codes coded on a bill (NetSuite GL accounts
// live in accounting_field_selections, both at bill level and per line item).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractGlCodes(raw: any): string[] {
  const codes = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collect = (sels: any[]) =>
    (sels ?? []).forEach((s) => {
      if (s?.category_info?.type === "GL_ACCOUNT" && s?.external_code) {
        codes.add(String(s.external_code));
      }
    });
  collect(raw.accounting_field_selections);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (raw.line_items ?? []).forEach((li: any) => collect(li.accounting_field_selections));
  return [...codes];
}

// Simple in-memory token cache (valid for duration of one function invocation)
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessTokenPublic(): Promise<string> {
  return getAccessToken();
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.token;
  }

  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("RAMP_CLIENT_ID or RAMP_CLIENT_SECRET is not set");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(RAMP_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "bills:read vendors:read",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ramp token error ${res.status}: ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function getBillsForApproval(): Promise<RampBill[]> {
  const bills: RampBill[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ approval_status: "PENDING", limit: "50" });
    if (cursor) params.set("start", cursor);

    const res = await fetch(`${RAMP_API_BASE}/bills?${params}`, {
      headers: await authHeaders(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ramp API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const page: RampBill[] = (data.data ?? []).map(normalizeBill);
    bills.push(...page);
    // Extract start cursor from next URL e.g. "...?start=xxx"
    const nextUrl = data.page?.next ?? null;
    cursor = nextUrl ? new URL(nextUrl).searchParams.get("start") : null;
  } while (cursor);

  return bills;
}

export async function getBillById(billId: string): Promise<RampBill | null> {
  const res = await fetch(`${RAMP_API_BASE}/bills/${billId}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return normalizeBill(data);
}

export async function getBillInvoiceUrl(billId: string): Promise<string | null> {
  const res = await fetch(`${RAMP_API_BASE}/bills/${billId}/documents`, {
    headers: await authHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data?.[0]?.file_url ?? null;
}

function parseAmount(val: unknown): number {
  if (typeof val === "number") return val;
  if (val && typeof val === "object") {
    const obj = val as Record<string, number>;
    const raw = obj.amount ?? 0;
    const rate = obj.minor_unit_conversion_rate ?? 1;
    return raw / rate;
  }
  return 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeBill(raw: any): RampBill {
  const totalAmount = parseAmount(raw.amount ?? raw.total_amount);
  return {
    id: raw.id,
    vendor: raw.vendor_name ?? raw.vendor?.name ?? raw.memo ?? "Unknown Vendor",
    invoiceNumber: raw.invoice_number ?? null,
    invoiceDate: raw.invoice_date ?? raw.due_date ?? raw.created_at ?? null,
    issuedAt: raw.issued_at ?? raw.invoice_date ?? raw.created_at ?? null,
    totalAmount,
    lineItems: (raw.line_items ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (li: any): RampLineItem => ({
        description: li.memo ?? li.description ?? li.category ?? "",
        amount: parseAmount(li.amount),
      })
    ),
    glCodes: extractGlCodes(raw),
    approvalStatus: raw.approval_status ?? raw.payment_status ?? "UNKNOWN",
    invoiceUrl: null,
  };
}
