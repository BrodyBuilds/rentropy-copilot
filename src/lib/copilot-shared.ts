// Client-safe shared definitions for Rentropy Copilot.
// The same fact builder feeds both the model prompt and the "Facts used" panel,
// so every fact shown to the reviewer is exactly a fact the model was given.

export const MESSAGE_TYPES = [
  { value: "late_rent", label: "Late rent" },
  { value: "renewal", label: "Renewal" },
  { value: "maintenance_update", label: "Maintenance update" },
  { value: "deposit_reply", label: "Deposit reply" },
  { value: "move_notice", label: "Move notice" },
] as const;

export const TONES = [
  { value: "friendly", label: "Friendly" },
  { value: "firm_but_fair", label: "Firm but fair" },
  { value: "formal", label: "Formal" },
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number]["value"];
export type Tone = (typeof TONES)[number]["value"];

export const MESSAGE_TYPE_VALUES = MESSAGE_TYPES.map((m) => m.value) as [
  MessageType,
  ...MessageType[],
];
export const TONE_VALUES = TONES.map((t) => t.value) as [Tone, ...Tone[]];

export function messageTypeLabel(value: string): string {
  return MESSAGE_TYPES.find((m) => m.value === value)?.label ?? value;
}

export function toneLabel(value: string): string {
  return TONES.find((t) => t.value === value)?.label ?? value;
}

export type TenantRecord = {
  id: string;
  full_name: string;
  property_label: string;
  lease_start: string;
  lease_end: string;
  rent_cents: number;
  due_day: number;
  balance_cents: number;
  lease_late_fee_cents: number;
  deposit_status: string;
  termination_date: string | null;
  possession_date: string | null;
};

export type TenantField = Exclude<keyof TenantRecord, "id">;

export type Fact = {
  label: string;
  value: string;
  /** The demo_tenants column this fact was read from. */
  field: TenantField;
};

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Formats a YYYY-MM-DD date without timezone drift. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const FACT_FIELDS: Record<MessageType, TenantField[]> = {
  late_rent: ["rent_cents", "due_day", "balance_cents", "lease_late_fee_cents"],
  renewal: ["lease_start", "lease_end", "rent_cents"],
  maintenance_update: [],
  deposit_reply: ["deposit_status"],
  move_notice: ["lease_end", "termination_date", "possession_date"],
};

function factFor(tenant: TenantRecord, field: TenantField): Fact | null {
  switch (field) {
    case "full_name":
      return { field, label: "Tenant name", value: tenant.full_name };
    case "property_label":
      return { field, label: "Property", value: tenant.property_label };
    case "rent_cents":
      return { field, label: "Monthly rent", value: formatCents(tenant.rent_cents) };
    case "due_day":
      return { field, label: "Rent due date", value: `${ordinal(tenant.due_day)} of each month` };
    case "balance_cents":
      return { field, label: "Current balance", value: formatCents(tenant.balance_cents) };
    case "lease_late_fee_cents":
      return {
        field,
        label: "Late fee in lease",
        value: formatCents(tenant.lease_late_fee_cents),
      };
    case "deposit_status":
      return { field, label: "Deposit status", value: tenant.deposit_status };
    case "lease_start":
      return { field, label: "Lease start", value: formatDate(tenant.lease_start) };
    case "lease_end":
      return { field, label: "Lease end", value: formatDate(tenant.lease_end) };
    case "termination_date":
      return tenant.termination_date
        ? { field, label: "Termination date", value: formatDate(tenant.termination_date) }
        : null;
    case "possession_date":
      return tenant.possession_date
        ? { field, label: "Possession date", value: formatDate(tenant.possession_date) }
        : null;
  }
}

/**
 * The facts a draft of this type may rely on. Empty values are dropped, so a
 * fact without a real source value is never presented as a fact.
 */
export function buildFacts(tenant: TenantRecord, messageType: MessageType): Fact[] {
  const fields: TenantField[] = ["full_name", "property_label", ...FACT_FIELDS[messageType]];
  return fields
    .map((field) => factFor(tenant, field))
    .filter((f): f is Fact => f !== null && f.value.trim() !== "");
}
