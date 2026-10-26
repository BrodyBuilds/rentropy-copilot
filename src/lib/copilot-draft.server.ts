import {
  messageTypeLabel,
  toneLabel,
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

export function buildDraftInput(args: {
  facts: Fact[];
  messageType: MessageType;
  tone: Tone;
}): string {
  const factLines = args.facts.map((f) => `- ${f.label}: ${f.value}`).join("\n");
  return `Message type: ${messageTypeLabel(args.messageType)}
Tone: ${toneLabel(args.tone)}

Tenant facts (the only facts you may use):
${factLines}

Write the draft now.`;
}
