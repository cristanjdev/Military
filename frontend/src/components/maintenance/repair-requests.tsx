"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, ClipboardCheck, Clock, Hammer, Loader2,
  MapPin, Plus, Send, ShieldCheck, Undo2, X, XCircle, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtDate, fmtPeso, wholePesoInput, MAINTENANCE_RESULTS } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { HelpBubble } from "@/components/ui/help-bubble";
import { useAuthStore, hasRole } from "@/store/auth";

/** The repair approval flow, shown in the "?" bubble next to the section title. */
const REPAIR_STEPS = [
  "The Armory Custodian reports the firearm for repair.",
  "The S4 Officer reviews it and forwards it to the Command Officer.",
  "The Command Officer approves or rejects the repair.",
  "The S4 Officer informs the Custodian of the decision.",
  "The Custodian sends the firearm for repair and records its return.",
];

/* Backend: RepairRequest::STATUS_*. */
export const REPAIR_STATUSES: Record<string, { label: string; tone: string }> = {
  reported:  { label: "Reported to S4",        tone: "pill-warn" },
  forwarded: { label: "Waiting for Commander", tone: "pill-info" },
  approved:  { label: "Approved",              tone: "pill-ok" },
  rejected:  { label: "Rejected",              tone: "pill-critical" },
  in_repair: { label: "In Repair",             tone: "pill-tactical" },
  completed: { label: "Back from Maintenance", tone: "pill-ok" },
};

type Person = { rank?: string; first_name?: string; last_name?: string; deleted_at?: string | null } | null;

export type Repair = {
  repair_id: number;
  equipment_id: number;
  status: keyof typeof REPAIR_STATUSES;
  problem: string;
  damaged_at: string;
  reported_at: string;
  estimated_cost: number | null;
  s4_notes: string | null;
  forwarded_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  custodian_informed_at: string | null;
  sent_at: string | null;
  received_by: string | null;
  received_by_unit: string | null;
  repaired_at: string | null;
  returned_at: string | null;
  result_status: number | null;
  cost: number | null;
  work_done: string | null;
  firearm?: { equipment_id: number; serial_number: string; model: string } | null;
  reporter?: Person;
  forwarder?: Person;
  decider?: Person;
  informer?: Person;
  sender?: Person;
  return_receiver?: Person;
};

export function personName(p?: Person): string {
  if (!p) return "—";
  const name = [p.rank, p.first_name, p.last_name].filter(Boolean).join(" ");
  return p.deleted_at ? `${name} (deleted account)` : name;
}

/** The steps of a repair, each with its date and who did it (shared with the firearm page). */
export function repairSteps(r: Repair) {
  const decided = r.status === "rejected" ? "Rejected by the Commander" : "Approved by the Commander";
  return [
    { label: "Firearm broke",                     at: r.damaged_at,            who: null,                  note: r.problem, dateOnly: true },
    { label: "Custodian reported to S4",          at: r.reported_at,           who: personName(r.reporter), note: null },
    { label: "S4 forwarded to the Commander",     at: r.forwarded_at,          who: personName(r.forwarder),
      note: [r.estimated_cost != null ? `Estimated ${fmtPeso(r.estimated_cost)}` : null, r.s4_notes].filter(Boolean).join(" · ") || null },
    { label: r.decided_at ? decided : "Commander's decision", at: r.decided_at, who: personName(r.decider), note: r.decision_note,
      failed: r.status === "rejected" },
    { label: "S4 reported back to the Custodian", at: r.custodian_informed_at, who: personName(r.informer), note: null },
    ...(r.status === "rejected" ? [] : [
      { label: "Sent for repair",                 at: r.sent_at,               who: personName(r.sender),
        note: r.received_by ? `Received by ${r.received_by}${r.received_by_unit ? ` (${r.received_by_unit})` : ""}` : null },
      { label: "Repaired",                        at: r.repaired_at,           who: r.received_by,          note: r.work_done, dateOnly: true },
      { label: "Back from maintenance",           at: r.returned_at,           who: personName(r.return_receiver),
        note: r.result_status ? `${MAINTENANCE_RESULTS[r.result_status]?.label}${r.cost ? ` · ${fmtPeso(r.cost)}` : ""}` : null },
    ]),
  ];
}

export function RepairRequests() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isCustodian = hasRole(user, "Armory Custodian");
  const isS4 = hasRole(user, "S4 Officer");
  const isCommander = hasRole(user, "Command Officer");

  const [filter, setFilter] = useState<Filter>("open");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ kind: DialogKind; repair?: Repair } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["repairs", filter, page],
    queryFn: async () => (await api.get("/repairs", { params: { page, per_page: 10, status: filter === "all" ? undefined : filter } })).data,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["repairs"] });
    qc.invalidateQueries({ queryKey: ["maintenance"] });
    qc.invalidateQueries({ queryKey: ["all-firearms"] });
  };

  /** The one action this user can take on a repair now, if any. */
  function actionFor(r: Repair): { kind: DialogKind; label: string; Icon: LucideIcon } | null {
    if (isS4 && r.status === "reported") return { kind: "forward", label: "Forward to Commander", Icon: Send };
    if (isCommander && r.status === "forwarded") return { kind: "decide", label: "Approve / Reject", Icon: ShieldCheck };
    if (isS4 && (r.status === "approved" || r.status === "rejected") && !r.custodian_informed_at)
      return { kind: "inform", label: "Inform Custodian", Icon: Undo2 };
    if (isCustodian && r.status === "approved" && r.custodian_informed_at) return { kind: "send", label: "Send for Repair", Icon: Hammer };
    if (isCustodian && r.status === "in_repair") return { kind: "complete", label: "Record Return", Icon: ClipboardCheck };
    return null;
  }

  /** What the repair is waiting for, for everyone who cannot act on it. */
  function waitingFor(r: Repair): string | null {
    switch (r.status) {
      case "reported":  return "Waiting for the S4 Officer to forward it";
      case "forwarded": return "Waiting for the Commander's approval";
      case "approved":
      case "rejected":  return r.custodian_informed_at
        ? (r.status === "approved" ? "Waiting for the Custodian to send it" : null)
        : "Waiting for the S4 Officer to inform the Custodian";
      case "in_repair": return "Out for repair: the Custodian records its return";
      default: return null;
    }
  }

  // How many repairs each tab holds (one small request per tab; "repairs" invalidations refresh them too).
  const { data: counts } = useQuery({
    queryKey: ["repairs", "counts"],
    queryFn: async () => {
      const res = await Promise.all(FILTERS.map(([key]) =>
        api.get("/repairs", { params: { per_page: 1, status: key === "all" ? undefined : key } })));
      return Object.fromEntries(FILTERS.map(([key], i) => [key, Number(res[i].data.total ?? 0)])) as Record<Filter, number>;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1.5">
          <p className="section-title flex items-center gap-2"><Hammer className="h-4 w-4" /> Repair Requests</p>
          <HelpBubble title="How a repair request works" label="How a repair request works">
            <ol className="space-y-2">
              {REPAIR_STEPS.map((step, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-olive-600/50 text-[10px] font-semibold text-olive-200">
                    {i + 1}
                  </span>
                  <span className="pt-px">{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 border-t border-steel-800 pt-2.5 text-steel-400">
              The firearm keeps its current status until it is back from repair.
            </p>
          </HelpBubble>
        </div>
        {isCustodian && (
          <button onClick={() => setDialog({ kind: "report" })} className="btn-primary text-xs shrink-0 self-start sm:self-auto">
            <Plus className="h-4 w-4" /> Report for Repair
          </button>
        )}
      </div>

      {/* Status tabs with counts, as on the Requests page */}
      <div className="flex flex-wrap gap-1 border-b border-steel-800" role="tablist" aria-label="Repair status">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            onClick={() => { setFilter(key); setPage(1); }}
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition",
              filter === key ? "border-olive-400 text-olive-50" : "border-transparent text-steel-400 hover:text-steel-200"
            )}
          >
            {label}
            {counts && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] font-semibold",
                  key === "open" && counts.open > 0 ? "bg-amber-500/20 text-amber-300" : "bg-steel-800 text-steel-400"
                )}
              >
                {counts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {isError && <DataError onRetry={refetch} />}
      {isLoading && !isError && <p className="py-8 text-center text-sm text-steel-400">Loading…</p>}
      {!isLoading && !isError && (data?.data?.length ?? 0) === 0 && (
        <div className="glass rounded-xl p-10 text-center text-sm text-steel-400">
          {filter === "open" ? "No repairs in progress." : filter === "completed" ? "No firearm is back from repair yet." : filter === "rejected" ? "No rejected repairs." : "No repair requests yet."}
        </div>
      )}

      {data?.data?.map((r: Repair) => (
        <RepairCard
          key={r.repair_id}
          repair={r}
          action={actionFor(r)}
          waiting={waitingFor(r)}
          onAction={(kind) => setDialog({ kind, repair: r })}
        />
      ))}

      {data && data.last_page > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-steel-400">{data.from}–{data.to} of {data.total} repairs</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn-ghost p-1.5 disabled:opacity-30" aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-steel-400">Page {page} of {data.last_page}</span>
            <button onClick={() => setPage((p) => Math.min(data.last_page, p + 1))} disabled={page === data.last_page} className="btn-ghost p-1.5 disabled:opacity-30" aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {dialog && (
        <RepairDialog
          kind={dialog.kind}
          repair={dialog.repair}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); refresh(); }}
        />
      )}
    </div>
  );
}

type Filter = "open" | "all" | "completed" | "rejected";
const FILTERS: [Filter, string][] = [
  ["open", "In Progress"],
  ["completed", "Back from Repair"],
  ["rejected", "Rejected"],
  ["all", "All"],
];

/** One repair: the firearm and problem, where it stands, the facts so far, and what happens next. */
function RepairCard({
  repair: r,
  action,
  waiting,
  onAction,
}: {
  repair: Repair;
  action: { kind: DialogKind; label: string; Icon: LucideIcon } | null;
  waiting: string | null;
  onAction: (kind: DialogKind) => void;
}) {
  const status = REPAIR_STATUSES[r.status];
  const facts = repairFacts(r);

  return (
    <article className="glass rounded-xl overflow-hidden">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-steel-400">
            <Link href={`/firearms/${r.equipment_id}`} className="font-mono text-sm font-semibold text-olive-100 hover:text-olive-300">
              {r.firearm?.serial_number ?? `#${r.equipment_id}`}
            </Link>
            {r.firearm?.model && <span className="text-xs text-steel-400">{r.firearm.model}</span>}
            <span className="text-steel-600">·</span>
            <span className="font-mono">Repair #{r.repair_id}</span>
          </p>
          <h3 className="mt-1.5 text-base font-semibold text-olive-50 break-words">{r.problem}</h3>
          <p className="mt-0.5 text-xs text-steel-400">
            Reported by <span className="text-steel-200">{personName(r.reporter)}</span> on {fmtDate(r.reported_at, LONG_DATE)}
          </p>
        </div>
        <span className={cn("pill text-[10px] uppercase self-start shrink-0", status?.tone ?? "pill-muted")}>
          {status?.label ?? r.status}
        </span>
      </div>

      <div className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
        <RepairProgress repair={r} />

        {/* Notes on the left; the estimated cost on the right, level with the last note */}
        {(facts.length > 0 || r.estimated_cost != null) && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
            <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
              {facts.map((f) => (
                <div key={f.label} className="min-w-0">
                  <dt className="text-[10px] text-steel-500">{f.label}</dt>
                  <dd className="text-xs text-steel-200 break-words">{f.value}</dd>
                </div>
              ))}
            </dl>
            {r.estimated_cost != null && (
              <div className="shrink-0 sm:text-right">
                <p className="text-[10px] text-steel-500">Estimated cost</p>
                <p className="text-base font-semibold text-olive-50">{fmtPeso(r.estimated_cost)}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {(action || waiting || r.status === "in_repair") && (
        <footer className="flex flex-col gap-3 border-t border-steel-800/80 bg-steel-950/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          {/* Left: what the repair is waiting for */}
          <div className="text-xs">
            {!action && waiting && (
              <span className="flex items-center gap-2 text-amber-300/90">
                <Clock className="h-4 w-4 shrink-0" aria-hidden /> {waiting}
              </span>
            )}
          </div>
          {/* Right: the buttons */}
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto sm:justify-end">
            {r.status === "in_repair" && (
              <Link href="/gps" className="btn-secondary text-xs no-underline">
                <MapPin className="h-4 w-4" /> Track on the map
              </Link>
            )}
            {action && (
              <button onClick={() => onAction(action.kind)} className="btn-primary text-xs shrink-0">
                <action.Icon className="h-4 w-4" /> {action.label}
              </button>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}

/** "November 14, 2026 at 9:15 AM" */
const LONG_DATE = "MMMM d, yyyy 'at' h:mm a";

/** The approval steps as a row of dots: done (check), current (ring), not yet (grey). */
function RepairProgress({ repair: r }: { repair: Repair }) {
  const rejected = r.status === "rejected";
  const stages = [
    { label: "Reported", at: r.reported_at },
    { label: "Forwarded", at: r.forwarded_at },
    { label: rejected ? "Rejected" : "Approved", at: r.decided_at, failed: rejected },
    { label: "Custodian informed", at: r.custodian_informed_at },
    ...(rejected ? [] : [
      { label: "Sent for repair", at: r.sent_at },
      { label: "Back from repair", at: r.returned_at },
    ]),
  ];
  const current = stages.findIndex((s) => !s.at);

  return (
    <ol className="grid grid-cols-2 gap-y-3 sm:flex sm:gap-0">
      {stages.map((s, i) => {
        const done = !!s.at;
        const isCurrent = i === current;
        return (
          <li key={s.label} className="relative flex min-w-0 flex-1 items-start gap-2 sm:flex-col sm:items-center sm:gap-1.5 sm:text-center">
            {/* The line joining this step to the next (wide screens) */}
            {i < stages.length - 1 && (
              <span
                className={cn("absolute left-1/2 top-2.5 hidden h-px w-full sm:block", stages[i + 1].at ? "bg-olive-500/60" : "bg-steel-700")}
                aria-hidden
              />
            )}
            <span
              className={cn(
                "relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                s.failed && done
                  ? "border-red-500/60 bg-red-500/15 text-red-300"
                  : done
                  ? "border-olive-500/60 bg-olive-600 text-white"
                  : isCurrent
                  ? "border-amber-400/70 bg-steel-900 text-amber-300"
                  : "border-steel-700 bg-steel-900 text-steel-600"
              )}
            >
              {s.failed && done ? <X className="h-3 w-3" /> : done ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <span className="min-w-0">
              <span className={cn("block text-[11px] leading-tight", done ? "text-steel-200" : isCurrent ? "text-amber-200" : "text-steel-500")}>
                {s.label}
              </span>
              <span className="block text-[10px] text-steel-500">{done ? fmtDate(s.at, "MMM d") : isCurrent ? "Next" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The details recorded so far, in plain words; empty ones are left out. */
function repairFacts(r: Repair): { label: string; value: string }[] {
  const facts: { label: string; value: string | null }[] = [
    { label: "Date damaged", value: r.damaged_at ? fmtDate(r.damaged_at, "MMMM d, yyyy") : null },
    { label: "S4 Officer's note", value: r.s4_notes },
    { label: r.status === "rejected" ? "Reason for rejection" : "Command Officer's note", value: r.decision_note },
    { label: "Repaired by", value: r.received_by ? `${r.received_by}${r.received_by_unit ? `, ${r.received_by_unit}` : ""}` : null },
    { label: "Work done", value: r.work_done },
    {
      label: "Result",
      value: r.result_status
        ? `${MAINTENANCE_RESULTS[r.result_status]?.label ?? "—"}${r.cost ? ` · ${fmtPeso(r.cost)}` : ""}`
        : null,
    },
  ];
  return facts.filter((f): f is { label: string; value: string } => !!f.value);
}

/** Every step with its date; steps not reached yet are dimmed. */
export function RepairTimeline({ repair }: { repair: Repair }) {
  const steps = repairSteps(repair);
  return (
    <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
      {steps.map((s, i) => {
        const done = !!s.at;
        const Icon = s.failed ? XCircle : done ? CheckCircle2 : Circle;
        return (
          <li key={i} className={`rounded-lg border p-2.5 ${done ? "border-olive-700/40 bg-steel-900/40" : "border-steel-800/60 opacity-50"}`}>
            <p className="text-[10px] uppercase tracking-widest text-olive-300 flex items-center gap-1.5">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${s.failed ? "text-red-400" : done ? "text-emerald-400" : "text-steel-500"}`} />
              {i + 1}. {s.label}
            </p>
            <p className="text-xs font-mono text-steel-200 mt-1">{done ? fmtDate(s.at, s.dateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm") : "—"}</p>
            {done && s.who && s.who !== "—" && <p className="text-[11px] text-steel-400">{s.who}</p>}
            {done && s.note && <p className="text-[11px] text-steel-400 break-words">{s.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}

type DialogKind = "report" | "forward" | "decide" | "inform" | "send" | "complete";

function RepairDialog({ kind, repair, onClose, onDone }: { kind: DialogKind; repair?: Repair; onClose: () => void; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<Record<string, string>>({
    equipment_id: "", problem: "", damaged_at: today,
    estimated_cost: "", s4_notes: "",
    note: "",
    received_by: "", received_by_unit: "",
    repaired_at: today, result_status: "1", cost: "0", work_done: "", next_schedule: "",
  });
  const [centavos, setCentavos] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const peso = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value, droppedCentavos } = wholePesoInput(e.target.value);
    setCentavos(droppedCentavos);
    set(k, value);
  };

  // Firearms that can be reported: in the armory (Available or Maintenance), not issued.
  const { data: firearms } = useQuery({
    queryKey: ["all-firearms"],
    queryFn: async () => (await api.get("/firearms", { params: { per_page: 200 } })).data,
    enabled: kind === "report",
  });
  const reportable = (firearms?.data ?? []).filter((f: any) => [1, 3].includes(Number(f.availability_status)));

  const submit = useMutation({
    mutationFn: async (decision?: "approved" | "rejected") => {
      const id = repair?.repair_id;
      switch (kind) {
        case "report":
          return api.post("/repairs", { equipment_id: Number(form.equipment_id), problem: form.problem, damaged_at: form.damaged_at });
        case "forward":
          return api.patch(`/repairs/${id}/forward`, {
            estimated_cost: form.estimated_cost === "" ? null : Number(form.estimated_cost), s4_notes: form.s4_notes || null,
          });
        case "decide":
          return api.patch(`/repairs/${id}/decide`, { decision, note: form.note || null });
        case "inform":
          return api.patch(`/repairs/${id}/inform`);
        case "send":
          return api.patch(`/repairs/${id}/send`, { received_by: form.received_by, received_by_unit: form.received_by_unit || null });
        case "complete":
          return api.patch(`/repairs/${id}/complete`, {
            repaired_at: form.repaired_at, result_status: Number(form.result_status), cost: Number(form.cost || 0),
            work_done: form.work_done, next_schedule: form.next_schedule || null,
          });
      }
    },
    onSuccess: (_res, decision) => {
      toast.success({
        report: "Reported to the S4 Officer.",
        forward: "Forwarded to the Command Officer.",
        decide: decision === "rejected" ? "Repair rejected. The S4 Officer will inform the Custodian." : "Repair approved. The S4 Officer will inform the Custodian.",
        inform: "The Armory Custodian was informed.",
        send: "Sent for repair. The firearm is now in Maintenance and stays tracked.",
        complete: "Return recorded. The firearm's status is updated.",
      }[kind]);
      onDone();
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? "Failed."),
  });

  const titles: Record<DialogKind, string> = {
    report: "Report a Firearm for Repair",
    forward: "Forward to the Command Officer",
    decide: "Approve or Reject the Repair",
    inform: "Inform the Armory Custodian",
    send: "Send for Repair",
    complete: "Record the Return from Maintenance",
  };

  const field = "input-field w-full";
  const label = "text-xs text-steel-400 mb-1 block";
  const req = <span className="text-red-400">*</span>;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="glass rounded-xl p-5 w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={(e) => { e.preventDefault(); if (kind !== "decide") submit.mutate(undefined); }} className="space-y-3">
          <div className="flex justify-between items-center gap-2">
            <p className="section-title">{titles[kind]}</p>
            <button type="button" onClick={onClose} className="btn-ghost text-xs"><X className="h-3.5 w-3.5" /></button>
          </div>

          {repair && (
            <div className="rounded-lg border border-steel-800 bg-steel-900/40 p-3 text-xs">
              <p className="font-mono font-bold text-olive-100">{repair.firearm?.serial_number} <span className="font-sans font-normal text-steel-400">{repair.firearm?.model}</span></p>
              <p className="text-steel-300 mt-0.5">{repair.problem}</p>
              <p className="text-steel-500 mt-0.5">Broke on {fmtDate(repair.damaged_at, "yyyy-MM-dd")} · reported {fmtDate(repair.reported_at)}</p>
            </div>
          )}

          {kind === "report" && (
            <>
              <div>
                <label className={label}>Firearm {req}</label>
                <select className={`${field} h-[42px]`} required value={form.equipment_id} onChange={(e) => set("equipment_id", e.target.value)}>
                  <option value="">— Select firearm —</option>
                  {reportable.map((f: any) => <option key={f.equipment_id} value={f.equipment_id}>{f.serial_number} · {f.model}</option>)}
                </select>
                <p className="text-[11px] text-steel-500 mt-1">An issued firearm must be returned first.</p>
              </div>
              <div>
                <label className={label}>When did it break? {req}</label>
                <input type="date" className={field} required max={today} value={form.damaged_at} onChange={(e) => set("damaged_at", e.target.value)} />
              </div>
              <div>
                <label className={label}>What is wrong? {req}</label>
                <textarea className={`${field} h-20`} required maxLength={500} value={form.problem} onChange={(e) => set("problem", e.target.value)}
                          placeholder="e.g. Broken firing pin, does not fire" />
              </div>
              <p className="text-[11px] text-steel-400">The S4 Officer is notified and forwards it to the Command Officer for approval. The firearm cannot be issued meanwhile.</p>
            </>
          )}

          {kind === "forward" && (
            <>
              <div>
                <label className={label}>Estimated cost (PHP)</label>
                <input type="text" inputMode="numeric" className={field} value={form.estimated_cost} onChange={peso("estimated_cost")} placeholder="Optional" />
                {centavos && <p className="text-[11px] text-amber-300 mt-1">Whole pesos only, no centavos.</p>}
              </div>
              <div>
                <label className={label}>Notes for the Commander</label>
                <textarea className={`${field} h-16`} maxLength={500} value={form.s4_notes} onChange={(e) => set("s4_notes", e.target.value)} placeholder="Optional" />
              </div>
            </>
          )}

          {kind === "decide" && (
            <>
              {(repair?.estimated_cost != null || repair?.s4_notes) && (
                <p className="text-xs text-steel-300">
                  From the S4 Officer: {repair?.estimated_cost != null && <>estimated {fmtPeso(repair.estimated_cost)}. </>}{repair?.s4_notes}
                </p>
              )}
              <div>
                <label className={label}>Note (optional)</label>
                <textarea className={`${field} h-16`} maxLength={500} value={form.note} onChange={(e) => set("note", e.target.value)} />
              </div>
            </>
          )}

          {kind === "inform" && (
            <p className="text-sm text-steel-300">
              The Commander <b className={repair?.status === "rejected" ? "text-red-300" : "text-emerald-300"}>{repair?.status}</b> this repair
              {repair?.decision_note ? ` (“${repair.decision_note}”)` : ""}. Confirm that you reported this back to the Armory Custodian. The date is recorded.
            </p>
          )}

          {kind === "send" && (
            <>
              <div>
                <label className={label}>Received by (who will repair it) {req}</label>
                <input className={field} required maxLength={100} value={form.received_by} onChange={(e) => set("received_by", e.target.value)} placeholder="e.g. SSG Juan Reyes" />
              </div>
              <div>
                <label className={label}>Unit / repair shop</label>
                <input className={field} maxLength={100} value={form.received_by_unit} onChange={(e) => set("received_by_unit", e.target.value)} placeholder="Optional" />
              </div>
              <p className="text-[11px] text-steel-400">The firearm becomes Maintenance and its tracker keeps reporting on the GPS map while it is away.</p>
            </>
          )}

          {kind === "complete" && (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className={label}>Date repaired {req}</label>
                  <input type="date" className={field} required max={today} min={repair?.damaged_at?.slice(0, 10)} value={form.repaired_at} onChange={(e) => set("repaired_at", e.target.value)} />
                </div>
                <div>
                  <label className={label}>Repair cost (PHP)</label>
                  <input type="text" inputMode="numeric" className={field} value={form.cost} onChange={peso("cost")}
                         onBlur={() => form.cost === "" && set("cost", "0")} />
                  {centavos && <p className="text-[11px] text-amber-300 mt-1">Whole pesos only, no centavos.</p>}
                </div>
              </div>
              <div>
                <label className={label}>Firearm status after repair {req}</label>
                <select className={`${field} h-[42px]`} value={form.result_status} onChange={(e) => set("result_status", e.target.value)}>
                  {Object.entries(MAINTENANCE_RESULTS).map(([v, r]) => <option key={v} value={v}>{r.label}</option>)}
                </select>
                <p className="text-[11px] text-steel-400 mt-1">{MAINTENANCE_RESULTS[Number(form.result_status)]?.hint}</p>
              </div>
              <div>
                <label className={label}>Work done {req}</label>
                <textarea className={`${field} h-16`} required maxLength={500} value={form.work_done} onChange={(e) => set("work_done", e.target.value)}
                          placeholder="e.g. Firing pin replaced, function check passed" />
              </div>
              <div>
                <label className={label}>Next maintenance</label>
                <input type="date" className={field} value={form.next_schedule} min={form.repaired_at} onChange={(e) => set("next_schedule", e.target.value)} />
              </div>
              <p className="text-[11px] text-steel-400">Record this only once the firearm is physically back in the armory.</p>
            </>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button>
            {kind === "decide" ? (
              <>
                <button type="button" disabled={submit.isPending} onClick={() => submit.mutate("rejected")} className="btn-primary text-xs bg-red-700 hover:bg-red-600">
                  {submit.isPending && submit.variables === "rejected" ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Reject
                </button>
                <button type="button" disabled={submit.isPending} onClick={() => submit.mutate("approved")} className="btn-primary text-xs">
                  {submit.isPending && submit.variables === "approved" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Approve
                </button>
              </>
            ) : (
              <button disabled={submit.isPending} className="btn-primary text-xs">
                {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : kind === "report" ? <AlertTriangle className="h-4 w-4" /> : null}
                {{ report: "Report to S4", forward: "Forward", inform: "Custodian Informed", send: "Send for Repair", complete: "Record Return", decide: "" }[kind]}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
