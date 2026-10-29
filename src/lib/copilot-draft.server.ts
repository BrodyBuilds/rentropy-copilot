import {
  messageTypeLabel,
  toneLabel,
  type DraftLanguage,
  type Fact,
  type MessageType,
  type Tone,
} from "./copilot-shared";

export const COPILOT_SYSTEM_RULES = `You draft messages from a landlord to a tenant. You only write words; you never take actions.

Rules:
- Be firm but fair. Respectful, clear, and human.
- Never threaten the tenant, never imply legal consequences, eviction, or penalties beyond what the facts state.
- Use ONLY the facts listed under "Tenant facts". Never invent dates, amounts, names, repairs, history, or policies. If a detail you would normally include is not in the facts, leave it out or use a neutral placeholder in square brackets like [time window].
- Never describe money actions: do not say anything will be charged, deducted, applied, withheld, refunded, or collected. You may restate an amount exactly as given in the facts.
- Write the message body only: a short greeting using the tenant's name, the message, and a sign-off of "[Your name]". No subject line, no commentary, no markdown.
- Keep it under 180 words.`;

/**
 * Extra instruction for a Spanish draft. The facts themselves never change; amounts and
 * dates are copied exactly as given so the rule checks read the Spanish text unchanged.
 */
export const SPANISH_DRAFT_INSTRUCTION = `Language: Spanish
Write the entire message in Spanish — greeting, body, and sign-off — in clear, plain, respectful Spanish. Every rule above still applies. Copy every dollar amount exactly as written in the facts (same $ sign, commas, and cents) and every date exactly as written in the facts; do not translate, convert, or reformat amounts or dates. The rent due day is not a date: say it naturally in Spanish (for example "1st of each month" becomes "el día 1 de cada mes"). Keep the tenant's name exactly as written, and keep the sign-off placeholder "[Your name]" exactly as written.`;

export function buildDraftInput(args: {
  facts: Fact[];
  messageType: MessageType;
  tone: Tone;
  language?: DraftLanguage;
}): string {
  const factLines = args.facts.map((f) => `- ${f.label}: ${f.value}`).join("\n");
  const languageBlock = args.language === "es" ? `\n${SPANISH_DRAFT_INSTRUCTION}\n` : "";
  return `Message type: ${messageTypeLabel(args.messageType)}
Tone: ${toneLabel(args.tone)}
${languageBlock}
Tenant facts (the only facts you may use):
${factLines}

Write the draft now.`;
}
