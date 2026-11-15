"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  Check, CheckCircle2, ClipboardCheck, Clock, Loader2, PackagePlus, Plus, Wrench, X, XCircle, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtDate, fmtPeso, wholePesoInput } from "@/lib/utils";
import { useAuthStore, hasRole } from "@/store/auth";
import { DataError } from "@/components/ui/data-error";

type RequestType = "new_firearm" | "repair_budget";
type RequestStatus = "pending" | "approved" | "rejected";

interface Person { rank?: string | null; first_name: string; last_name: string }

interface LogisticsRequest {
  request_id: number;
  type: RequestType;
  title: string;
  details?: string | null;
  quantity?: number | null;
  estimated_cost: number;
  items?: { equipment_id: number; serial_number?: string | null; cost: number }[] | null;
  status: RequestStatus;
  requester?: Person | null;
  decider?: Person | null;
  decided_at?: string | null;
  decision_note?: string | null;
  created_at: string;
}

interface RepairItem { equipment_id: number; serial_number: string; model: string; result: string; last_job: string; date: string | null; cost: number }

const TYPE_LABEL: Record<RequestType, string> = { new_firearm: "New Firearm", repair_budget: "Repair Budget" };
const TYPE_ICON: Record<RequestType, LucideIcon> = { new_firearm: PackagePlus, repair_budget: Wrench };
const STATUS_LABEL: Record<RequestStatus, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
const STATUS_TONE: Record<RequestStatus, string> = { pending: "pill-warn", approved: "pill-ok", rejected: "pill-critical" };

/** "November 14, 2026 at 9:15 AM" */
const LONG_DATE = "MMMM d, yyyy 'at' h:mm a";

const name = (p?: Person | null) => (p ? `${p.rank ? `${p.rank} ` : ""}${p.first_name} ${p.last_name}` : "—");

/** One request: what is asked and why, its cost, and the decision (or the buttons to make it). */
function RequestCard({
  req: r,
  canDecide,
  onDecide,
}: {
  req: LogisticsRequest;
  canDecide: boolean;
  onDecide: (decision: "approved" | "rejected") => void;
}) {
  const TypeIcon = TYPE_ICON[r.type];
  const items = r.items ?? [];
  const perUnit = r.quantity ? Math.round(r.estimated_cost / r.quantity) : 0;

  return (
    <article className="glass rounded-xl overflow-hidden">
      {/* Heading: what is asked, by whom, and the amount */}
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-steel-400">
            <TypeIcon className="h-3.5 w-3.5 shrink-0 text-olive-300" aria-hidden />
            <span className="font-semibold uppercase tracking-wider text-olive-300">{TYPE_LABEL[r.type]}</span>
            <span className="text-steel-600">·</span>
            <span className="font-mono">Request #{r.request_id}</span>
          </p>
          <h3 className="mt-1.5 text-base font-semibold text-olive-50 break-words">{r.title}</h3>
          <p className="mt-0.5 text-xs text-steel-400">
            {r.requester ? <>Submitted by <span className="text-steel-200">{name(r.requester)}</span> on </> : "Submitted on "}
            {fmtDate(r.created_at, LONG_DATE)}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 sm:block sm:shrink-0 sm:text-right">
          <span className={cn("pill text-[10px] uppercase", STATUS_TONE[r.status])}>{STATUS_LABEL[r.status]}</span>
          <div className="sm:mt-2">
            <p className="text-lg font-bold leading-tight text-olive-50">{fmtPeso(r.estimated_cost)}</p>
            <p className="text-[11px] text-steel-500">
              {r.type === "new_firearm"
                ? r.quantity
                  ? `${r.quantity} unit${r.quantity === 1 ? "" : "s"} · about ${fmtPeso(perUnit)} each`
                  : "Estimated cost"
                : `Repair of ${items.length} firearm${items.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
      </div>

      {/* Justification and, for a repair budget, the firearms and their costs */}
      {(r.details || items.length > 0) && (
        <div className="grid gap-4 px-4 pb-4 sm:px-5 sm:pb-5 md:grid-cols-2">
          {r.details && (
            <div className={cn("min-w-0", items.length === 0 && "md:col-span-2")}>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-steel-500">Justification</p>
              <p className="text-sm leading-relaxed text-steel-300 whitespace-pre-line break-words">{r.details}</p>
            </div>
          )}
          {items.length > 0 && (
            <div className={cn("min-w-0", !r.details && "md:col-span-2")}>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-steel-500">Firearms to repair</p>
              <table className="w-full text-xs">
                <tbody className="divide-y divide-steel-800/70">
                  {items.map((i) => (
                    <tr key={i.equipment_id}>
                      <td className="py-1.5 font-mono text-steel-200">{i.serial_number ?? `#${i.equipment_id}`}</td>
                      <td className="py-1.5 text-right text-steel-300">{fmtPeso(i.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-steel-700">
                    <td className="pt-1.5 text-steel-400">Total</td>
                    <td className="pt-1.5 text-right font-semibold text-olive-100">{fmtPeso(r.estimated_cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Decision */}
      <footer className="flex flex-col gap-3 border-t border-steel-800/80 bg-steel-950/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        {r.status === "pending" ? (
          <p className="flex items-center gap-2 text-xs text-amber-300/90">
            <Clock className="h-4 w-4 shrink-0" aria-hidden />
            Waiting for the Command Officer&apos;s decision
          </p>
        ) : (
          <div className="min-w-0 text-xs">
            <p className={cn("flex items-center gap-2", r.status === "approved" ? "text-emerald-300" : "text-red-300")}>
              {r.status === "approved"
                ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                : <XCircle className="h-4 w-4 shrink-0" aria-hidden />}
              <span>
                {STATUS_LABEL[r.status]}{r.decider ? <> by <span className="font-semibold">{name(r.decider)}</span></> : ""}
                {r.decided_at && <span className="text-steel-400"> on {fmtDate(r.decided_at, LONG_DATE)}</span>}
              </span>
            </p>
            {r.decision_note && (
              <p className="mt-1 pl-6 text-steel-300 break-words">
                <span className="text-steel-500">{r.status === "rejected" ? "Reason: " : "Note: "}</span>
                {r.decision_note}
              </p>
            )}
          </div>
        )}

        {canDecide && r.status === "pending" && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => onDecide("rejected")} className="btn-secondary text-xs">
              <X className="h-3.5 w-3.5" /> Reject
            </button>
            <button onClick={() => onDecide("approved")} className="btn-primary text-xs">
              <Check className="h-3.5 w-3.5" /> Approve
            </button>
          </div>
        )}
      </footer>
    </article>
  );
}

function errorText(e: unknown, fallback: string) {
  if (e instanceof AxiosError) {
    const d = e.response?.data as { message?: string; errors?: Record<string, string[]> } | undefined;
    return (d?.errors && Object.values(d.errors)[0]?.[0]) ?? d?.message ?? fallback;
  }
  return fallback;
}

/** Whole number as typed (pesos or a quantity): the leading 0 is replaced and decimals are dropped. */
const pesoInput = (v: string) => wholePesoInput(v).value;

export default function RequestsPage() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canCreate = hasRole(user, "S4 Officer", "Administrator");
  const canDecide = hasRole(user, "Command Officer");

  const [status, setStatus] = useState<"" | RequestStatus>("");
  const [showForm, setShowForm] = useState(false);
  const [deciding, setDeciding] = useState<{ req: LogisticsRequest; decision: "approved" | "rejected" } | null>(null);
  const [note, setNote] = useState("");

  // All requests at once, so each tab can show its count; the tabs filter on this page.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["logistics-requests"],
    queryFn: async () => (await api.get<{ data: LogisticsRequest[] }>("/requests", { params: { per_page: 200 } })).data,
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: string }) => api.patch(`/requests/${id}/decide`, { decision, note: note || null }),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "approved" ? "Request approved." : "Request rejected.");
      setDeciding(null);
      setNote("");
      qc.invalidateQueries({ queryKey: ["logistics-requests"] });
    },
    onError: (e) => toast.error(errorText(e, "Could not save the decision.")),
  });

  const all = data?.data ?? [];
  const rows = status ? all.filter((r) => r.status === status) : all;
  const countOf = (s: "" | RequestStatus) => (s ? all.filter((r) => r.status === s).length : all.length);

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-olive-300" /> Requests</h1>
          <p className="text-sm text-steel-400 max-w-2xl">
            Requests for new firearms and repair budgets from the S4 Officer, for the Command Officer&apos;s decision.
          </p>
        </div>
        {canCreate && (
          <button onClick={() => setShowForm(true)} className="btn-primary"><Plus className="h-4 w-4" /> New Request</button>
        )}
      </div>

      {/* Status tabs with counts */}
      <div className="flex flex-wrap gap-1 border-b border-steel-800" role="tablist" aria-label="Request status">
        {(["", "pending", "approved", "rejected"] as const).map((s) => (
          <button
            key={s || "all"}
            type="button"
            role="tab"
            onClick={() => setStatus(s)}
            aria-selected={status === s}
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition",
              status === s ? "border-olive-400 text-olive-50" : "border-transparent text-steel-400 hover:text-steel-200"
            )}
          >
            {s ? STATUS_LABEL[s] : "All"}
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-semibold",
                s === "pending" && countOf(s) > 0 ? "bg-amber-500/20 text-amber-300" : "bg-steel-800 text-steel-400"
              )}
            >
              {countOf(s)}
            </span>
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {isError && <DataError onRetry={refetch} />}
        {isLoading && !isError && <p className="text-steel-400 text-sm">Loading…</p>}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="glass rounded-xl p-8 text-center text-sm text-steel-400">
            {status ? `No ${STATUS_LABEL[status].toLowerCase()} requests.` : "No requests yet."}
          </div>
        )}
        {rows.map((r) => (
          <RequestCard
            key={r.request_id}
            req={r}
            canDecide={canDecide}
            onDecide={(decision) => setDeciding({ req: r, decision })}
          />
        ))}
      </div>

      {showForm && <NewRequestForm onClose={() => setShowForm(false)} />}

      {deciding && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setDeciding(null)}>
          <div className="glass rounded-xl p-6 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
            <p className="section-title">{deciding.decision === "approved" ? "Approve request" : "Reject request"}</p>
            <p className="text-sm text-steel-300">
              #{deciding.req.request_id} · {deciding.req.title} · {fmtPeso(deciding.req.estimated_cost)}
            </p>
            <div>
              <label className="text-xs text-steel-400 mb-1 block">Note to the S4 Officer (optional)</label>
              <textarea className="input-field w-full h-20" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeciding(null)} className="btn-secondary text-xs">Cancel</button>
              <button
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: deciding.req.request_id, decision: deciding.decision })}
                className={cn("btn-primary text-xs", deciding.decision === "rejected" && "bg-red-700 hover:bg-red-600")}
              >
                {decide.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {deciding.decision === "approved" ? "Approve" : "Reject"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function NewRequestForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<RequestType>("new_firearm");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [cost, setCost] = useState("0");
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  /** Estimated repair cost per firearm, as typed; starts at the cost of its last maintenance job. */
  const [repairCosts, setRepairCosts] = useState<Record<number, string>>({});

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["repair-summary"],
    queryFn: async () => (await api.get<{ items: RepairItem[]; total_cost: number }>("/requests/repair-summary")).data,
    enabled: type === "repair_budget",
  });

  const repairItems = summary?.items ?? [];
  const repairCostOf = (i: RepairItem) => Number(repairCosts[i.equipment_id] ?? i.cost) || 0;
  const chosen = repairItems.filter((i) => selected[i.equipment_id] ?? true);
  const chosenTotal = chosen.reduce((sum, i) => sum + repairCostOf(i), 0);
  // With firearms listed, the budget is their total; the server computes it the same way.
  const itemized = type === "repair_budget" && repairItems.length > 0;

  const REPAIR_TITLE = "Repair budget for firearms needing repair";
  const switchType = (t: RequestType) => {
    setType(t);
    if (t === "repair_budget" && !title) setTitle(REPAIR_TITLE);
    if (t === "new_firearm" && title === REPAIR_TITLE) setTitle("");
  };

  const save = useMutation({
    mutationFn: () => api.post("/requests", {
      type,
      title,
      details: details || null,
      quantity: type === "new_firearm" ? Number(quantity || 0) : null,
      estimated_cost: itemized ? chosenTotal : Number(cost || 0),
      items: itemized ? chosen.map((i) => ({ equipment_id: i.equipment_id, cost: repairCostOf(i) })) : null,
    }),
    onSuccess: () => {
      toast.success("Request sent to the Command Officer.");
      qc.invalidateQueries({ queryKey: ["logistics-requests"] });
      onClose();
    },
    onError: (e) => toast.error(errorText(e, "Could not send the request.")),
  });

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <form
        onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
        onClick={(e) => e.stopPropagation()}
        className="glass rounded-xl p-5 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto space-y-3"
      >
        <div className="flex justify-between items-center">
          <p className="section-title">New Request to the Command Officer</p>
          <button type="button" onClick={onClose} className="btn-ghost text-xs"><X className="h-3.5 w-3.5" /></button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(["new_firearm", "repair_budget"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => switchType(t)}
              className={cn(
                "rounded-md border px-3 py-2 text-sm font-medium transition",
                type === t ? "border-olive-400/70 bg-olive-700/35 text-olive-50" : "border-steel-700/70 bg-steel-900/50 text-steel-300"
              )}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        <div>
          <label className="text-xs text-steel-400 mb-1 block">Title <span className="text-red-400">*</span></label>
          <input className="input-field w-full" required maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)}
                 placeholder={type === "new_firearm" ? "e.g. 5 × M4 Carbine for reserve training" : ""} />
        </div>

        {type === "repair_budget" && (
          <div className="rounded-lg border border-steel-800 bg-steel-900/40 p-3">
            <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-2">Firearms that need repair (from maintenance records)</p>
            {summaryLoading && <p className="text-xs text-steel-400">Loading…</p>}
            {!summaryLoading && repairItems.length === 0 && (
              <p className="text-xs text-steel-400">No firearm is marked Needs Further Repair or Unserviceable.</p>
            )}
            <ul className="space-y-1.5">
              {repairItems.map((i) => {
                const on = selected[i.equipment_id] ?? true;
                return (
                  <li key={i.equipment_id} className="flex items-start justify-between gap-3">
                    <label className="flex items-start gap-2 text-xs text-steel-200 min-w-0">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-olive-500"
                        checked={on}
                        onChange={(e) => setSelected({ ...selected, [i.equipment_id]: e.target.checked })}
                      />
                      <span className="min-w-0">
                        <span className="font-mono font-semibold text-olive-100">{i.serial_number}</span> {i.model} · {i.result}
                        <span className="block text-steel-500">
                          {i.last_job}{i.date ? ` (${i.date})` : ""}{i.cost > 0 ? ` · last job ${fmtPeso(i.cost)}` : ""}
                        </span>
                      </span>
                    </label>
                    <input
                      aria-label={`Repair cost for ${i.serial_number}`}
                      className="input-field w-28 shrink-0 py-1 text-right text-xs"
                      inputMode="numeric"
                      disabled={!on}
                      value={repairCosts[i.equipment_id] ?? String(i.cost)}
                      onChange={(e) => setRepairCosts({ ...repairCosts, [i.equipment_id]: pesoInput(e.target.value) })}
                      onBlur={() => repairCosts[i.equipment_id] === "" && setRepairCosts({ ...repairCosts, [i.equipment_id]: "0" })}
                    />
                  </li>
                );
              })}
            </ul>
            {repairItems.length > 0 && (
              <div className="mt-2 flex items-center justify-between border-t border-steel-800 pt-2 text-xs">
                <span className="text-steel-400">Total repair budget ({chosen.length} firearm{chosen.length === 1 ? "" : "s"})</span>
                <span className="font-semibold text-olive-100">{fmtPeso(chosenTotal)}</span>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {type === "new_firearm" && (
            <div>
              <label className="text-xs text-steel-400 mb-1 block">Quantity <span className="text-red-400">*</span></label>
              <input className="input-field w-full" inputMode="numeric" required value={quantity} onChange={(e) => setQuantity(pesoInput(e.target.value))} />
            </div>
          )}
          {!itemized && (
            <div className={type === "new_firearm" ? "" : "col-span-2"}>
              <label className="text-xs text-steel-400 mb-1 block">Estimated cost (PHP) <span className="text-red-400">*</span></label>
              <input className="input-field w-full" inputMode="numeric" required value={cost}
                     onChange={(e) => setCost(pesoInput(e.target.value))} onBlur={() => cost === "" && setCost("0")} />
            </div>
          )}
        </div>

        <div>
          <label className="text-xs text-steel-400 mb-1 block">Justification</label>
          <textarea className="input-field w-full h-20" maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)}
                    placeholder="Why it is needed" />
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button>
          <button disabled={save.isPending || (itemized && chosen.length === 0)} className="btn-primary text-xs">
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Send Request
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
