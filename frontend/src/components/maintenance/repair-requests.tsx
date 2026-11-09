"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Circle, ClipboardCheck, Hammer, Loader2,
  MapPin, Plus, Send, ShieldCheck, Undo2, X, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fmtDate, fmtPeso, wholePesoInput, MAINTENANCE_RESULTS } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { useAuthStore, hasRole } from "@/store/auth";

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

  const [filter, setFilter] = useState<"open" | "all" | "completed" | "rejected">("open");
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
  function actionFor(r: Repair): { kind: DialogKind; label: string; Icon: any } | null {
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

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <p className="section-title flex items-center gap-2"><Hammer className="h-4 w-4" /> Repair Requests</p>
            <p className="text-xs text-steel-400 mt-1">
              Custodian reports to S4 → S4 forwards to the Commander → Commander approves → S4 informs the Custodian → Custodian sends it for repair.
              The firearm&apos;s status changes only when it comes back.
            </p>
          </div>
          {isCustodian && (
            <button onClick={() => setDialog({ kind: "report" })} className="btn-primary text-xs shrink-0">
              <Plus className="h-4 w-4" /> Report for Repair
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {(["open", "all", "completed", "rejected"] as const).map((f) => (
            <button key={f} onClick={() => { setFilter(f); setPage(1); }}
                    className={`px-3 py-1.5 rounded-md text-[11px] uppercase tracking-widest transition-all ${
                      filter === f ? "bg-olive-700/40 text-olive-100 border border-olive-500/40" : "text-steel-400 hover:text-olive-200"
                    }`}>
              {f === "open" ? "In Progress" : f === "completed" ? "Back from Maintenance" : f}
            </button>
          ))}
        </div>
      </div>

      {isError && <DataError onRetry={refetch} />}
      {isLoading && !isError && <p className="text-center py-8 text-steel-400 text-sm">Loading…</p>}
      {!isLoading && !isError && (data?.data?.length ?? 0) === 0 && (
        <p className="glass rounded-xl text-center py-10 text-steel-500 text-xs">No repair requests here.</p>
      )}

      {data?.data?.map((r: Repair) => {
        const action = actionFor(r);
        const waiting = waitingFor(r);
        return (
          <div key={r.repair_id} className="glass rounded-xl p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/firearms/${r.equipment_id}`} className="font-mono font-bold text-olive-100 hover:text-olive-300">
                    {r.firearm?.serial_number ?? `#${r.equipment_id}`}
                  </Link>
                  <span className="text-xs text-steel-400">{r.firearm?.model}</span>
                  <span className={`pill text-[10px] ${REPAIR_STATUSES[r.status]?.tone ?? "pill-muted"}`}>{REPAIR_STATUSES[r.status]?.label ?? r.status}</span>
                  <span className="text-[10px] text-steel-500 font-mono">Request #{r.repair_id}</span>
                </div>
                <p className="text-sm text-steel-200 mt-1 break-words">{r.problem}</p>
              </div>
              <div className="flex flex-col items-start sm:items-end gap-1 shrink-0">
                {action && (
                  <button onClick={() => setDialog({ kind: action.kind, repair: r })} className="btn-primary text-xs">
                    <action.Icon className="h-4 w-4" /> {action.label}
                  </button>
                )}
                {!action && waiting && <p className="text-[11px] text-amber-300/90">{waiting}</p>}
                {r.status === "in_repair" && (
                  <Link href="/gps" className="text-[11px] text-olive-300 hover:text-olive-200 flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Track on the map
                  </Link>
                )}
              </div>
            </div>
            <RepairTimeline repair={r} />
          </div>
        );
      })}

      {data && data.last_page > 1 && (
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn-ghost p-1.5 disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-steel-400 font-mono">Page {page} / {data.last_page}</span>
          <button onClick={() => setPage((p) => Math.min(data.last_page, p + 1))} disabled={page === data.last_page} className="btn-ghost p-1.5 disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
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
