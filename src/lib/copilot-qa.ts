// Slice 4: read-only landlord Q&A about ONE tenant. Pure code, no I/O.
// Scope, single-fact answers, the not-in-the-record rule, and checking the
// model's figures are all decided here in code; the model only phrases
// compound answers from the facts it is handed, and its answer is discarded
// if any dollar amount or date in it does not match the tenant's row.
// Self-contained so the whole Q&A feature can be deleted without touching other slices.

import { findMoney } from "./copilot-risk";
import { formatCents, formatDate, type TenantField, type TenantRecord } from "./copilot-shared";

export const CROSS_SCOPE_MESSAGE =
  "That question is about a different tenant — open their page to ask about them";
export const QA_FAILED_MESSAGE = "Couldn't answer just now — please try again.";
export const NOT_IN_RECORD = "Not in the record";

export type QaFact = {
  field: TenantField;
  label: string;
  /** Display value (cents shown as dollars). */
  value: string;
  /** The exact stored value in demo_tenants. */
  raw: string | number;
};

export type QaAnswerKind = "direct" | "not_in_record" | "model" | "model_discarded";

export type QaAnswer = { kind: QaAnswerKind; answer: string; facts: QaFact[] };

export type Topic =
  | "balance"
  | "rent"
  | "due_day"
  | "late_fee"
  | "deposit_status"
  | "lease_start"
  | "lease_end"
  | "lease_dates"
  | "move_out"
  | "summary";

export type Missing =
  | "deposit_amount"
  | "deposit_deadline"
  | "contact"
  | "payment_history"
  | "unit"
  | "personal"
  | "other_records";

export type QaPlan =
  | { kind: "refused"; message: string }
  | { kind: "answered"; answer: QaAnswer; topics: Topic[]; missing: Missing[] }
  | { kind: "needs_model"; facts: QaFact[]; topics: Topic[] };

/* ---------- Facts ---------- */

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function qaFact(t: TenantRecord, field: TenantField): QaFact | null {
  switch (field) {
    case "full_name":
      return { field, label: "Tenant name", value: t.full_name, raw: t.full_name };
    case "property_label":
      return { field, label: "Property", value: t.property_label, raw: t.property_label };
    case "rent_cents":
      return { field, label: "Monthly rent", value: formatCents(t.rent_cents), raw: t.rent_cents };
    case "due_day":
      return { field, label: "Rent due day", value: `${ordinal(t.due_day)} of each month`, raw: t.due_day };
    case "balance_cents":
      return { field, label: "Current balance", value: formatCents(t.balance_cents), raw: t.balance_cents };
    case "lease_late_fee_cents":
      return {
        field,
        label: "Late fee in lease",
        value: formatCents(t.lease_late_fee_cents),
        raw: t.lease_late_fee_cents,
      };
    case "deposit_status":
      return { field, label: "Deposit status", value: t.deposit_status, raw: t.deposit_status };
    case "lease_start":
      return { field, label: "Lease start", value: formatDate(t.lease_start), raw: t.lease_start };
    case "lease_end":
      return { field, label: "Lease end", value: formatDate(t.lease_end), raw: t.lease_end };
    case "termination_date":
      return t.termination_date
        ? { field, label: "Termination date", value: formatDate(t.termination_date), raw: t.termination_date }
        : null;
    case "possession_date":
      return t.possession_date
        ? { field, label: "Possession date", value: formatDate(t.possession_date), raw: t.possession_date }
        : null;
  }
}

function factsFor(t: TenantRecord, fields: TenantField[]): QaFact[] {
  const out: QaFact[] = [];
  for (const field of fields) {
    const f = qaFact(t, field);
    if (f && String(f.raw).trim() !== "" && !out.some((o) => o.field === f.field)) out.push(f);
  }
  return out;
}

const ALL_FIELDS: TenantField[] = [
  "full_name",
  "property_label",
  "lease_start",
  "lease_end",
  "rent_cents",
  "due_day",
  "balance_cents",
  "lease_late_fee_cents",
  "deposit_status",
  "termination_date",
  "possession_date",
];

const TOPIC_FIELDS: Record<Topic, TenantField[]> = {
  balance: ["balance_cents"],
  rent: ["rent_cents"],
  due_day: ["due_day"],
  late_fee: ["lease_late_fee_cents"],
  deposit_status: ["deposit_status"],
  lease_start: ["lease_start"],
  lease_end: ["lease_end"],
  lease_dates: ["lease_start", "lease_end"],
  move_out: ["termination_date", "possession_date"],
  summary: ALL_FIELDS,
};

/* ---------- Step 1: scope check ---------- */

// Capitalised words that are not names. Any other capitalised word that is not
// part of this tenant's name or property is treated as naming someone/somewhere else.
const COMMON_WORDS = new Set(
  `a an the and or but if of to for on in at by with from about as into onto than then so also just only
is are was were be been being am do does did done has have had will would can could should shall may might must
isn doesn hasn wasn didn won don aren haven shouldn couldn wouldn weren hadn let lets
what whats when where which who whom whose why how any anything all both each every either neither some none
this that these those there here it its i me my mine we us our ours you your yours he him his she her hers they them their theirs
tenant landlord renter resident lease leases leased rent rental rents balance balances deposit deposits security
late fee fees charge charges penalty due date dates day days month months monthly year years week weeks
start starts started starting begin begins began end ends ended ending expire expires expiry expiration term period length
amount amounts much many owe owes owed owing outstanding overdue behind paid pay pays payment payments arrears unpaid
status held disputed returned refund refunded return deadline back current currently now today still yet ever never
please thanks thank hi hey hello ok okay yes no not tell show give list summarize summarise summary overview explain
check confirm remind find look get know need want quick question total dollar dollars usd ai copilot rentropy
mr mrs ms miss mx dr nc north carolina usa
january february march april june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday
termination possession move moving moved out vacate notice phone email number contact address unit apartment apt
property home house record records file info information detail details fact facts everything something nothing
exactly right correct true over under more less before after until since next last first second each per one two three
again often same new old interest legal law eviction repair repairs maintenance renewal renew increase
whether like via vs versus compared compare plus include including included`
    .split(/\s+/)
    .filter(Boolean),
);

const OTHER_SCOPE =
  /\b(?:other|another|different|all|every|both)\s+(?:tenants?|renters?|residents?|propert(?:y|ies)|units?|buildings?|leases)\b|\btenants\b|\bproperties\b|\b(?:everyone|everybody|anyone else|someone else|somebody else)\b/i;

const ADDRESS =
  /\b\d+\s+(?:[\p{L}]+\s+){0,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl|circle|cir)\b/giu;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when the question names a tenant or property other than this tenant's. */
export function isCrossScope(question: string, tenant: Pick<TenantRecord, "full_name" | "property_label">): boolean {
  const q = question.normalize("NFKC");
  if (OTHER_SCOPE.test(q)) return true;

  const own = new Set([...words(tenant.full_name), ...words(tenant.property_label)]);
  for (const m of q.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}]*/gu)) {
    const word = m[0].toLowerCase();
    if (own.has(word) || COMMON_WORDS.has(word)) continue;
    return true;
  }

  const ownProperty = tenant.property_label.toLowerCase();
  for (const m of q.matchAll(ADDRESS)) {
    if (!ownProperty.includes(m[0].toLowerCase())) return true;
  }
  return false;
}

/* ---------- Step 2/4: what is being asked ---------- */

const MISSING_INFO: Record<Missing, { reason: (t: TenantRecord) => string; known: TenantField[] }> = {
  deposit_amount: {
    reason: () => "the record stores the deposit's status, not its amount.",
    known: ["deposit_status"],
  },
  deposit_deadline: {
    reason: (t) =>
      !t.termination_date && !t.possession_date
        ? "no termination or possession date is recorded, so no deposit deadline can be given."
        : "the record doesn't store a deposit deadline.",
    known: ["deposit_status", "termination_date", "possession_date"],
  },
  contact: {
    reason: () => "the record doesn't store phone numbers, email addresses, or other contact details.",
    known: ["full_name", "property_label"],
  },
  payment_history: {
    reason: () => "the record doesn't store payment dates or payment history.",
    known: ["balance_cents", "due_day"],
  },
  unit: {
    reason: () => "the record stores the property, not a unit number.",
    known: ["property_label"],
  },
  personal: {
    reason: () => "the record doesn't store that.",
    known: [],
  },
  other_records: {
    reason: () => "the record doesn't store that.",
    known: [],
  },
};

export function detectMissing(question: string): Missing[] {
  const q = question.toLowerCase();
  const out: Missing[] = [];
  const deposit = /deposit/.test(q);
  if (deposit && /(how much|amount|\$|\bdollars?\b|\bsize\b|\bvalue\b|\bsum\b|\bworth\b)/.test(q)) {
    out.push("deposit_amount");
  }
  if (deposit && /(deadline|\breturn|\brefund|\bback\b|\bdue\b|\bwhen\b|how long|\bdays\b)/.test(q)) {
    out.push("deposit_deadline");
  }
  if (
    /\b(phone|cell|mobile|telephone|e-?mail|contact|address|reach (him|her|them)|text (him|her|them))\b/.test(q)
  ) {
    out.push("contact");
  }
  if (
    /(last payment|payment history|paid (on|last)|when did .{0,30}\bpa(y|id)\b|(times|often|ever) (been )?late|late (before|history)|payment date|on time)/.test(
      q,
    )
  ) {
    out.push("payment_history");
  }
  if (/\b(unit|apartment|apt|suite)\s*(number|no\.?|#|\d)|\bwhich (unit|apartment)\b/.test(q)) {
    out.push("unit");
  }
  if (
    /\b(ssn|social security|birthday|date of birth|dob|age|how old|employer|job|income|salary|credit (score|check|history)|pets?|vehicles?|car|license plate|occupants?|roommates?|children|kids|spouse|emergency contact|bank|background check)\b/.test(
      q,
    )
  ) {
    out.push("personal");
  }
  if (
    /\b(maintenance|repairs?|work orders?|complaints?|violations?|eviction|notes?|warnings?|insurance|utilities|parking|keys?|inspections?|rent increase|interest)\b/.test(
      q,
    )
  ) {
    out.push("other_records");
  }
  return out;
}

export function detectTopics(question: string, missing: Missing[] = detectMissing(question)): Topic[] {
  const q = question.toLowerCase();
  const found = new Set<Topic>();

  if (/(summar|overview|everything|tell me about|what do (we|you|i) know|rundown|snapshot|full picture|key facts|all (the )?(facts|details|info))/.test(q)) {
    found.add("summary");
  }
  if (/\b(balance|owe[sd]?|owing|outstanding|behind|past[- ]due|overdue|arrears?|unpaid|delinquent|paid up|caught up|current on)\b/.test(q) || /\blate\b(?!\s*(fee|charge|penalt))/.test(q)) {
    found.add("balance");
  }
  const withoutPastDue = q.replace(/past[- ]due|overdue/g, " ");
  const depositMissing = missing.includes("deposit_amount") || missing.includes("deposit_deadline");
  if (/\bdue\b/.test(withoutPastDue) && /(rent|when|day|date)/.test(withoutPastDue) && !depositMissing) {
    found.add("due_day");
  }
  if (/\blate (fee|charge|penalt)|\bfees?\b/.test(q)) found.add("late_fee");
  if (/deposit/.test(q) && !depositMissing) found.add("deposit_status");

  const leaseDates = /lease (term|dates?|period|length|duration|runs?)\b|how long is .{0,20}lease|when does .{0,20}lease run/.test(q);
  if (leaseDates) {
    found.add("lease_dates");
  } else {
    if (/\b(lease|move[- ]?in)\b.{0,25}\b(start|begin|began|commence)|\b(start|begin|began|commence)\w*\b.{0,25}\blease\b|move[- ]?in date|when did .{0,20}move in/.test(q)) {
      found.add("lease_start");
    }
    if (/\blease\b.{0,25}\b(end|expir|up\b|over\b|finish|run out)|\b(end|expir)\w*\b.{0,25}\blease\b|\bexpir(e|es|ation|y)\b/.test(q)) {
      found.add("lease_end");
    }
  }
  if (/\b(termination|possession|move[- ]?out|moving out|vacat\w*|leaving)\b/.test(q)) found.add("move_out");

  // Rent is mentioned in many questions about other facts ("when is rent due?");
  // it only counts on its own, or when the question compares against it.
  if (/\brent\b|monthly (payment|amount)/.test(q)) {
    const others = [...found].filter((t) => t !== "summary").length;
    const compares = /(monthly rent|rent amount|amount of rent|how much (is|does) (the |her |his |their )?(monthly )?rent|rent (cost|price)|months? of rent|how many months|more than|less than|compare|versus|\bvs\b|equal|same as|times)/.test(q);
    if (others === 0 || compares) found.add("rent");
  }

  const order: Topic[] = ["summary", "balance", "rent", "due_day", "late_fee", "deposit_status", "lease_dates", "lease_start", "lease_end", "move_out"];
  return order.filter((t) => found.has(t));
}

/* ---------- Direct answers ---------- */

function directSentence(topic: Topic, t: TenantRecord): string {
  const f = (field: TenantField) => qaFact(t, field)?.value ?? "";
  switch (topic) {
    case "balance":
      return `The current balance is ${f("balance_cents")}.`;
    case "rent":
      return `Monthly rent is ${f("rent_cents")}.`;
    case "due_day":
      return `Rent is due on the ${f("due_day")}.`;
    case "late_fee":
      return `The late fee in the lease is ${f("lease_late_fee_cents")}.`;
    case "deposit_status":
      return `The deposit status is “${f("deposit_status")}”.`;
    case "lease_start":
      return `The lease start date is ${f("lease_start")}.`;
    case "lease_end":
      return `The lease end date is ${f("lease_end")}.`;
    case "lease_dates":
      return `The lease runs from ${f("lease_start")} to ${f("lease_end")}.`;
    case "move_out": {
      const parts: string[] = [];
      parts.push(t.termination_date ? `The termination date is ${f("termination_date")}.` : "No termination date is recorded.");
      parts.push(t.possession_date ? `The possession date is ${f("possession_date")}.` : "No possession date is recorded.");
      return parts.join(" ");
    }
    case "summary":
      return "";
  }
}

function knownLine(facts: QaFact[]): string {
  if (facts.length === 0) return "";
  return ` What the record does show: ${facts.map((f) => `${f.label.toLowerCase()} ${f.value}`).join("; ")}.`;
}

const RECORD_CONTENTS =
  "this record only holds the tenant's name, property, lease start and end dates, monthly rent, rent due day, balance, lease late fee, deposit status, and termination and possession dates.";

/**
 * Decides, in code, how a question is answered. Only `needs_model` results
 * go to the model, and then only with the facts listed in the plan.
 */
export function planAnswer(question: string, tenant: TenantRecord): QaPlan {
  if (isCrossScope(question, tenant)) return { kind: "refused", message: CROSS_SCOPE_MESSAGE };

  const missing = detectMissing(question);
  const topics = detectTopics(question, missing);

  // Step 4: anything the row doesn't hold is "Not in the record" plus what is known.
  if (missing.length > 0) {
    const reasons = [...new Set(missing.map((m) => MISSING_INFO[m].reason(tenant)))];
    const known = factsFor(tenant, [
      ...missing.flatMap((m) => MISSING_INFO[m].known),
      ...topics.flatMap((t) => (t === "summary" ? [] : TOPIC_FIELDS[t])),
    ]);
    const answer = `${NOT_IN_RECORD} — ${reasons.join(" Also, ")}${knownLine(known)}`;
    return { kind: "answered", answer: { kind: "not_in_record", answer, facts: known }, topics, missing };
  }

  if (topics.length === 0) {
    return {
      kind: "answered",
      answer: { kind: "not_in_record", answer: `${NOT_IN_RECORD} — ${RECORD_CONTENTS}`, facts: [] },
      topics,
      missing,
    };
  }

  // Step 3: compound questions go to the model with only the relevant facts.
  if (topics.includes("summary") || topics.length >= 2) {
    const fields: TenantField[] = topics.includes("summary")
      ? ALL_FIELDS
      : ["full_name", ...topics.flatMap((t) => TOPIC_FIELDS[t])];
    return { kind: "needs_model", facts: factsFor(tenant, fields), topics };
  }

  // Step 2: a single stored fact is answered straight from the row.
  const topic = topics[0] as Topic;
  const facts = factsFor(tenant, TOPIC_FIELDS[topic]);
  if (topic === "move_out" && facts.length === 0) {
    const known = factsFor(tenant, ["lease_end"]);
    return {
      kind: "answered",
      answer: {
        kind: "not_in_record",
        answer: `${NOT_IN_RECORD} — no termination or possession date is recorded.${knownLine(known)}`,
        facts: known,
      },
      topics,
      missing,
    };
  }
  return {
    kind: "answered",
    answer: { kind: "direct", answer: directSentence(topic, tenant), facts },
    topics,
    missing,
  };
}

/* ---------- Step 3: model prompt and verification ---------- */

export const QA_SYSTEM_PROMPT = `You answer a landlord's question about ONE tenant. You are read-only: you never send messages, write letters, or take any action.
Use ONLY the facts in the JSON you are given. Hard rules:
- Never state any fact, amount, date, deadline, law, or policy that is not in tenant_facts.
- Copy every dollar amount and date exactly as written in tenant_facts. Do not add, subtract, multiply, or project amounts or dates: no totals, no differences, no future or past dates.
- If tenant_facts do not answer part of the question, say "Not in the record" for that part.
- Never guess and never give legal advice.
- Answer in one to three short, plain sentences. No greeting, no sign-off, no lists, no markdown.`;

export function buildQaInput(question: string, facts: QaFact[]): string {
  const payload = {
    tenant_facts: facts.map((f) => ({ field: f.field, label: f.label, value: f.value })),
    question,
  };
  return `${JSON.stringify(payload, null, 2)}\n\nAnswer the question using only tenant_facts.`;
}

type DateParts = { y?: number | undefined; m?: number | undefined; d?: number | undefined };
export type DateMention = DateParts & { text: string; start: number; end: number };

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MON = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
const ORD = "(?:st|nd|rd|th)?";

const RELATIVE_DATE =
  /\b(today|tomorrow|yesterday|tonight|(?:next|last|this|coming) (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:in|within) \d+ (?:days?|weeks?|months?)|\d+ (?:days?|weeks?|months?) (?:from|after|before|ago|late|past))\b/gi;

/** Every date-like mention in `text`, with the parts it states. */
export function findDates(text: string): DateMention[] {
  const out: DateMention[] = [];
  const overlaps = (s: number, e: number) => out.some((o) => s < o.end && e > o.start);
  const add = (re: RegExp, parse: (m: RegExpMatchArray) => DateParts) => {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      out.push({ ...parse(m), text: m[0], start, end });
    }
  };
  const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  const month = (s: string | undefined) => (s ? MONTHS[s.toLowerCase()] : undefined);

  add(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m) => ({
    m: month(m[1]), d: num(m[2]), y: num(m[3]),
  }));
  add(new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MON}\\.?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m) => ({
    d: num(m[1]), m: month(m[2]), y: num(m[3]),
  }));
  add(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m) => ({ y: num(m[1]), m: num(m[2]), d: num(m[3]) }));
  add(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => {
    const y = num(m[3]);
    return { m: num(m[1]), d: num(m[2]), y: y !== undefined && y < 100 ? 2000 + y : y };
  });
  add(new RegExp(`\\b${MON}\\.?,?\\s+(\\d{4})\\b`, "gi"), (m) => ({ m: month(m[1]), y: num(m[2]) }));
  add(/\b((?:19|20)\d{2})\b/g, (m) => ({ y: num(m[1]) }));
  add(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, (m) => ({ d: num(m[1]) }));
  add(RELATIVE_DATE, () => ({}));
  return out.sort((a, b) => a.start - b.start);
}

const MONEY_FIELDS: TenantField[] = ["rent_cents", "balance_cents", "lease_late_fee_cents"];
const DATE_FIELDS: TenantField[] = ["lease_start", "lease_end", "termination_date", "possession_date"];

/**
 * Every dollar amount and every date in the model's answer must exactly match
 * a value from the facts it was given (which all come from the tenant's row).
 */
export function verifyModelAnswer(answer: string, facts: QaFact[]): { ok: boolean; mismatches: string[] } {
  const cents = new Set(facts.filter((f) => MONEY_FIELDS.includes(f.field)).map((f) => Number(f.raw)));
  const dates: DateParts[] = facts
    .filter((f) => DATE_FIELDS.includes(f.field))
    .map((f) => {
      const [y, m, d] = String(f.raw).split("-").map(Number);
      return { y, m, d };
    });
  const dueDay = facts.find((f) => f.field === "due_day");

  const mismatches: string[] = [];
  for (const money of findMoney(answer)) {
    if (!cents.has(money.cents)) mismatches.push(money.text);
  }
  for (const date of findDates(answer)) {
    const stated = date.y !== undefined || date.m !== undefined || date.d !== undefined;
    const matchesRowDate =
      stated &&
      dates.some(
        (r) =>
          (date.y === undefined || date.y === r.y) &&
          (date.m === undefined || date.m === r.m) &&
          (date.d === undefined || date.d === r.d),
      );
    const isDueDay =
      date.y === undefined && date.m === undefined && date.d !== undefined && dueDay !== undefined && date.d === Number(dueDay.raw);
    if (!matchesRowDate && !isDueDay) mismatches.push(date.text);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Used when the model's answer is discarded: list the facts that answer the question. */
export function fallbackAnswer(facts: QaFact[]): QaAnswer {
  const answering = facts.filter((f) => f.field !== "full_name");
  if (answering.length === 0) {
    return { kind: "model_discarded", answer: `${NOT_IN_RECORD}.`, facts: [] };
  }
  return {
    kind: "model_discarded",
    answer: `From the record: ${answering.map((f) => `${f.label.toLowerCase()} ${f.value}`).join("; ")}.`,
    facts: answering,
  };
}
