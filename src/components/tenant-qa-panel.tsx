// Slice 4: "Ask about this tenant" panel. Self-contained; delete this file, its
// one line on the tenant page, and src/lib/copilot-qa*.ts to remove the feature.

import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Lock, MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askAboutTenant } from "@/lib/copilot-qa.functions";
import { QA_FAILED_MESSAGE, type QaAnswer } from "@/lib/copilot-qa";
import type { TenantRecord } from "@/lib/copilot-shared";

const SOURCE_NOTE: Record<QaAnswer["kind"], string> = {
  direct: "Answered straight from the record.",
  not_in_record: "Answered straight from the record.",
  model: "Worded by AI from the facts below; every amount and date was checked against the record.",
  model_discarded:
    "The AI's wording was set aside because a figure in it didn't match the record, so only the facts are listed.",
};

export function TenantQaPanel({ tenant }: { tenant: Pick<TenantRecord, "id" | "full_name"> }) {
  const ask = useServerFn(askAboutTenant);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [answer, setAnswer] = useState<QaAnswer | null>(null);
  const [asked, setAsked] = useState("");

  // When the tenant changes, wipe the question, answer and facts used during render,
  // so one tenant's answer is never shown, even for a frame, under another's name.
  const [scopeId, setScopeId] = useState(tenant.id);
  if (scopeId !== tenant.id) {
    setScopeId(tenant.id);
    setQuestion("");
    setAsking(false);
    setError(null);
    setRefusal(null);
    setAnswer(null);
    setAsked("");
  }

  // An answer that arrives after the tenant changed belongs to the old tenant: drop it.
  const currentTenantId = useRef(tenant.id);
  useEffect(() => {
    currentTenantId.current = tenant.id;
  }, [tenant.id]);

  const firstName = tenant.full_name.split(" ")[0] ?? tenant.full_name;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    const askedFor = tenant.id;
    const stillSameTenant = () => currentTenantId.current === askedFor;
    setAsking(true);
    setError(null);
    setRefusal(null);
    setAnswer(null);
    try {
      const res = await ask({ data: { tenant_id: askedFor, question: q } });
      if (!stillSameTenant()) return;
      setAsked(q);
      if (!res.ok) setError(res.error);
      else if (res.outcome === "refused") setRefusal(res.message);
      else setAnswer(res.answer);
    } catch (err) {
      console.error(err);
      if (stillSameTenant()) setError(QA_FAILED_MESSAGE);
    } finally {
      if (stillSameTenant()) setAsking(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5" aria-labelledby="tenant-qa-heading">
      <h2 id="tenant-qa-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <MessageCircleQuestion className="h-5 w-5" /> Ask about this tenant
      </h2>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3.5 w-3.5" /> Read-only — answers come only from this tenant's record
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder={`e.g. What does ${firstName} owe, and when is rent due?`}
          aria-label="Question about this tenant"
          className="bg-background"
        />
        <Button type="submit" disabled={asking || question.trim() === ""}>
          {asking ? "Asking…" : "Ask"}
        </Button>
      </form>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {refusal && (
        <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-warning px-4 py-3 text-sm text-warning-foreground" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {refusal}
        </p>
      )}

      {answer && (
        <div className="mt-4 rounded-md border border-border bg-background p-4" role="status">
          <p className="text-xs text-muted-foreground">“{asked}”</p>
          <p className="mt-2 leading-relaxed text-foreground">{answer.answer}</p>
          <p className="mt-2 text-xs text-muted-foreground">{SOURCE_NOTE[answer.kind]}</p>
          <div className="mt-3 border-t border-border pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Facts used</p>
            {answer.facts.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">None — nothing in the record answers this.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {answer.facts.map((f) => (
                  <li key={f.field} className="text-sm text-foreground">
                    {f.label}: <span className="font-medium">{f.value}</span>{" "}
                    <span className="font-mono text-[11px] text-muted-foreground">
                      demo_tenants.{f.field} = {String(f.raw)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
