"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Plus, Wrench, Loader2, Calendar, AlertTriangle, CheckCircle, Clock, X, ChevronLeft, ChevronRight, Hammer } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtDate, fmtPeso, wholePesoInput, CONDITIONS, MAINTENANCE_RESULTS } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { RepairRequests } from "@/components/maintenance/repair-requests";
import { useAuthStore, hasRole } from "@/store/auth";

export default function MaintenancePage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [centavosHint, setCentavosHint] = useState(false);
  const user = useAuthStore((s) => s.user);
  // Repair and maintenance are the Armory Custodian's job; the others follow the records.
  const canRecord = hasRole(user, "Armory Custodian");
  const [tab, setTab] = useState<"repairs" | "history" | "schedule">("repairs");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["maintenance", page],
    queryFn: async () => (await api.get("/maintenance", { params: { page, per_page: 15 } })).data,
  });

  const { data: firearms } = useQuery({
    queryKey: ["all-firearms"],
    queryFn: async () => (await api.get("/firearms", { params: { per_page: 200 } })).data,
  });

  const [form, setForm] = useState({
    equipment_id: "",
    description: "",
    maintenance_date: new Date().toISOString().slice(0, 10),
    next_schedule: "",
    // Repairs go through the approval on the Repairs tab, not this form.
    maintenance_type: "Inspection",
    result_status: 1,
    // Kept as text so typing replaces the leading 0 ("0" then "1" gives "1", not "01").
    cost: "0",
    remarks: "",
  });

  const create = useMutation({
    mutationFn: () => api.post("/maintenance", { ...form, equipment_id: Number(form.equipment_id), cost: Number(form.cost) }),
    onSuccess: () => {
      toast.success("Maintenance recorded.");
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["maintenance"] });
      // The result changes the firearm's status (Available / Maintenance) and next due date.
      qc.invalidateQueries({ queryKey: ["all-firearms"] });
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? "Failed."),
  });

  // Upcoming maintenance schedule from firearms data
  const upcomingMaintenance = (firearms?.data ?? [])
    .filter((f: any) => f.next_maintenance_due)
    .map((f: any) => ({
      equipment_id: f.equipment_id,
      serial_number: f.serial_number,
      model: f.model,
      condition: f.condition_status,
      due_date: f.next_maintenance_due,
      is_overdue: new Date(f.next_maintenance_due) < new Date(),
      days_until: Math.ceil((new Date(f.next_maintenance_due).getTime() - Date.now()) / 86400000),
    }))
    .sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2"><Wrench className="h-5 w-5 text-olive-300" /> Maintenance</h1>
          <p className="text-sm text-steel-400">{TAB_INFO[tab]}</p>
        </div>
        {canRecord && tab !== "repairs" && (
          <button onClick={() => setShowForm((s) => !s)} className="btn-primary"><Plus className="h-4 w-4" /> New Record</button>
        )}
      </div>

      {/* Section switcher: one segmented group of buttons */}
      <div
        className="inline-flex w-full sm:w-auto rounded-lg border border-steel-700/70 bg-steel-900/60 p-1 gap-1"
        role="tablist"
        aria-label="Maintenance sections"
      >
        {([
          ["repairs", "Repairs", Hammer],
          ["history", "History", Wrench],
          ["schedule", "Schedule", Calendar],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "inline-flex flex-1 sm:flex-none items-center justify-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition",
              tab === key
                ? "bg-olive-600 text-white shadow-sm"
                : "text-steel-300 hover:bg-steel-800 hover:text-steel-100"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" /> {label}
          </button>
        ))}
      </div>

      {showForm && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="glass rounded-xl p-5 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
              <div className="flex justify-between items-center">
                <p className="section-title">New Maintenance Record</p>
                <button type="button" onClick={() => setShowForm(false)} className="btn-ghost text-xs"><X className="h-3.5 w-3.5" /></button>
              </div>

              {/* Firearm & Type */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-1.5">Firearm & Type</p>
                <div className="grid md:grid-cols-[2fr_1fr] gap-3">
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Firearm <span className="text-red-400">*</span></label>
                    <select className="input-field w-full h-[42px]" required value={form.equipment_id}
                            onChange={(e) => setForm({ ...form, equipment_id: e.target.value })}>
                      <option value="">— Select firearm —</option>
                      {firearms?.data?.map((f: any) => <option key={f.equipment_id} value={f.equipment_id}>{f.serial_number} · {f.model}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Type <span className="text-red-400">*</span></label>
                    <select className="input-field w-full h-[42px]" value={form.maintenance_type}
                            onChange={(e) => setForm({ ...form, maintenance_type: e.target.value })}>
                      <option>Inspection</option><option>Cleaning</option><option>Calibration</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Dates & Condition */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-1.5">Date & Assessment</p>
                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Maintenance Date <span className="text-red-400">*</span></label>
                    <input type="date" className="input-field w-full" value={form.maintenance_date}
                           onChange={(e) => setForm({ ...form, maintenance_date: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Next Schedule</label>
                    <input type="date" className="input-field w-full" value={form.next_schedule}
                           onChange={(e) => setForm({ ...form, next_schedule: e.target.value })} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs text-steel-400 mb-1 block">Firearm Status After {form.maintenance_type} <span className="text-red-400">*</span></label>
                    <select className="input-field w-full h-[42px]" value={form.result_status}
                            onChange={(e) => setForm({ ...form, result_status: Number(e.target.value) })}>
                      {Object.entries(MAINTENANCE_RESULTS).map(([value, r]) => (
                        <option key={value} value={value}>{r.label}</option>
                      ))}
                    </select>
                    <p className="text-[11px] text-steel-400 mt-1">{MAINTENANCE_RESULTS[form.result_status]?.hint}</p>
                  </div>
                </div>
              </div>

              {/* Cost & Description */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-1.5">Details & Cost</p>
                <div className="grid md:grid-cols-[1fr_2fr] gap-3">
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Cost (PHP)</label>
                    <input type="text" inputMode="numeric" className="input-field w-full" value={form.cost}
                           onChange={(e) => {
                             const { value, droppedCentavos } = wholePesoInput(e.target.value);
                             setCentavosHint(droppedCentavos);
                             setForm({ ...form, cost: value });
                           }}
                           onBlur={() => form.cost === "" && setForm({ ...form, cost: "0" })} />
                    {centavosHint && <p className="text-[11px] text-amber-300 mt-1">Whole pesos only, no centavos.</p>}
                  </div>
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Description <span className="text-red-400">*</span></label>
                    <input className="input-field w-full" required placeholder="Work performed" value={form.description}
                           onChange={(e) => setForm({ ...form, description: e.target.value })} />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs text-steel-400 mb-1 block">Remarks</label>
                <textarea className="input-field w-full h-16" placeholder="Optional notes" value={form.remarks}
                          onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
              </div>

              <div className="flex gap-2 justify-end pt-3">
                <button type="button" onClick={() => setShowForm(false)} className="btn-secondary text-xs">Cancel</button>
                <button disabled={create.isPending} className="btn-primary text-xs">
                  {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save Record
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {tab === "repairs" && <RepairRequests />}

      {/* Schedule: overdue first, then this week, then later */}
      {tab === "schedule" && (
        <div className="space-y-6">
          {upcomingMaintenance.length === 0 && (
            <div className="glass rounded-xl p-10 text-center text-sm text-steel-400">No maintenance is scheduled.</div>
          )}
          {SCHEDULE_GROUPS.map((g) => {
            const items = upcomingMaintenance.filter(g.match);
            if (items.length === 0) return null;
            return (
              <section key={g.key}>
                <h2 className={cn("mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider", g.heading)}>
                  <g.Icon className="h-3.5 w-3.5" /> {g.label}
                  <span className="rounded-full bg-steel-800 px-1.5 py-px text-[10px] text-steel-400">{items.length}</span>
                </h2>
                <div className="glass rounded-xl overflow-hidden">
                  {/* Wide screens: a table like History; fixed column widths so every group lines up */}
                  <table className="hidden w-full table-fixed text-sm md:table">
                    <colgroup>
                      <col className="w-[28%]" /><col className="w-[24%]" /><col className="w-[16%]" /><col className="w-[16%]" /><col className="w-[16%]" />
                    </colgroup>
                    <thead className="bg-steel-900/50 text-[11px] text-steel-400">
                      <tr>
                        <th className="px-5 py-2.5 text-left font-semibold">Firearm</th>
                        <th className="px-3 py-2.5 text-center font-semibold">Model</th>
                        <th className="px-3 py-2.5 text-center font-semibold">Condition</th>
                        <th className="px-3 py-2.5 text-center font-semibold">Due date</th>
                        <th className="px-5 py-2.5 text-center font-semibold">Time left</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-steel-800/70">
                      {items.map((item: ScheduleItem) => (
                        <tr key={item.equipment_id} className="hover:bg-steel-800/20 transition-colors">
                          <td className="px-5 py-3">
                            <Link href={`/firearms/${item.equipment_id}`} className="font-mono text-sm font-semibold text-olive-100 hover:text-olive-300">
                              {item.serial_number}
                            </Link>
                          </td>
                          <td className="truncate px-3 py-3 text-center text-xs text-steel-300" title={item.model}>{item.model}</td>
                          <td className="px-3 py-3 text-center">
                            {CONDITIONS[item.condition] && (
                              <span className={cn("pill text-[10px]", CONDITIONS[item.condition].tone)}>{CONDITIONS[item.condition].label}</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-center text-xs text-steel-200">{fmtDate(item.due_date, "MMMM d, yyyy")}</td>
                          <td className={cn("whitespace-nowrap px-5 py-3 text-center text-xs font-medium", dueTone(item))}>
                            {dueText(item.days_until)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Phones: one card per firearm */}
                  <ul className="divide-y divide-steel-800/70 md:hidden">
                    {items.map((item: ScheduleItem) => (
                      <li key={item.equipment_id} className="space-y-1 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <Link href={`/firearms/${item.equipment_id}`} className="font-mono text-sm font-semibold text-olive-100 hover:text-olive-300">
                              {item.serial_number}
                            </Link>
                            <span className="ml-2 text-xs text-steel-400">{item.model}</span>
                          </div>
                          {CONDITIONS[item.condition] && (
                            <span className={cn("pill shrink-0 text-[10px]", CONDITIONS[item.condition].tone)}>{CONDITIONS[item.condition].label}</span>
                          )}
                        </div>
                        <p className="text-xs text-steel-300">
                          {fmtDate(item.due_date, "MMMM d, yyyy")} · <span className={cn("font-medium", dueTone(item))}>{dueText(item.days_until)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* History: newest first */}
      {tab === "history" && (
        <div className="glass rounded-xl overflow-hidden">
          {isError && <div className="p-4"><DataError onRetry={refetch} /></div>}
          {isLoading && !isError && <p className="py-8 text-center text-sm text-steel-400">Loading…</p>}
          {!isLoading && !isError && (!data?.data || data.data.length === 0) && (
            <p className="py-10 text-center text-sm text-steel-400">No maintenance records yet.</p>
          )}

          {data?.data?.length > 0 && (
            <>
              {/* Wide screens: a table */}
              <table className="hidden w-full text-sm md:table">
                <thead className="bg-steel-900/50 text-left text-[11px] font-semibold text-steel-400">
                  <tr>
                    <th className="px-5 py-2.5 font-semibold">Date</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Firearm</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Work done</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Result</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Done by</th>
                    <th className="px-5 py-2.5 text-center font-semibold">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-steel-800/70">
                  {data.data.map((m: any) => (
                    <tr key={m.maintenance_id} className="align-middle hover:bg-steel-800/20 transition-colors">
                      <td className="whitespace-nowrap px-5 py-3 text-xs text-steel-300">{fmtDate(m.maintenance_date, "MMM d, yyyy")}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-center">
                        <FirearmCell firearm={m.firearm} />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <p className="text-xs font-medium text-steel-100">{m.maintenance_type}</p>
                        <p className="mx-auto mt-0.5 max-w-md text-xs text-steel-400 break-words">{m.description}</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-center"><ResultPill status={m.result_status} /></td>
                      <td className="whitespace-nowrap px-3 py-3 text-center text-xs text-steel-300">{doneBy(m)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-center text-xs text-steel-200">
                        {Number(m.cost) > 0 ? fmtPeso(m.cost) : <span className="text-steel-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Phones: one card per record */}
              <ul className="divide-y divide-steel-800/70 md:hidden">
                {data.data.map((m: any) => (
                  <li key={m.maintenance_id} className="space-y-1.5 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <FirearmCell firearm={m.firearm} />
                      <ResultPill status={m.result_status} />
                    </div>
                    <p className="text-xs text-steel-200">
                      <span className="font-medium">{m.maintenance_type}</span>
                      <span className="text-steel-400"> · {m.description}</span>
                    </p>
                    <p className="text-[11px] text-steel-500">
                      {fmtDate(m.maintenance_date, "MMM d, yyyy")} · {doneBy(m)}
                      {Number(m.cost) > 0 && <> · <span className="text-steel-300">{fmtPeso(m.cost)}</span></>}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {data && data.last_page > 1 && (
            <div className="flex items-center justify-between border-t border-steel-800/70 px-5 py-3">
              <p className="text-xs text-steel-400">
                {data.from}–{data.to} of {data.total} records
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1 || isLoading}
                  className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-steel-400">Page {page} of {data.last_page}</span>
                <button
                  onClick={() => setPage((p) => Math.min(data.last_page, p + 1))}
                  disabled={page === data.last_page || isLoading}
                  className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The one-line description under the page title, per section. */
const TAB_INFO = {
  repairs: "Repair requests for damaged firearms, from report to return.",
  history: "Every inspection, cleaning, calibration and repair recorded for the firearms.",
  schedule: "When each firearm is next due for maintenance.",
} as const;

interface ScheduleItem {
  equipment_id: number;
  serial_number: string;
  model: string;
  condition: number;
  due_date: string;
  is_overdue: boolean;
  days_until: number;
}

const SCHEDULE_GROUPS = [
  { key: "overdue", label: "Overdue", Icon: AlertTriangle, heading: "text-red-300", match: (i: ScheduleItem) => i.is_overdue },
  { key: "soon", label: "Due within 7 days", Icon: Clock, heading: "text-amber-300", match: (i: ScheduleItem) => !i.is_overdue && i.days_until <= 7 },
  { key: "later", label: "Later", Icon: CheckCircle, heading: "text-steel-400", match: (i: ScheduleItem) => !i.is_overdue && i.days_until > 7 },
];

const dueTone = (i: ScheduleItem) => (i.is_overdue ? "text-red-300" : i.days_until <= 7 ? "text-amber-300" : "text-steel-400");

function dueText(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `In ${days} days`;
}

function FirearmCell({ firearm }: { firearm?: { equipment_id: number; serial_number: string; model?: string } | null }) {
  if (!firearm) return <span className="text-xs text-steel-500">Archived firearm</span>;
  return (
    <div>
      <Link href={`/firearms/${firearm.equipment_id}`} className="font-mono text-xs font-semibold text-olive-100 hover:text-olive-300">
        {firearm.serial_number}
      </Link>
      {firearm.model && <p className="text-[11px] text-steel-500">{firearm.model}</p>}
    </div>
  );
}

function ResultPill({ status }: { status: number }) {
  const r = MAINTENANCE_RESULTS[status];
  return <span className={cn("pill text-[10px]", r?.tone ?? "pill-muted")}>{r?.label ?? "—"}</span>;
}

/** The outside technician when one is named, otherwise the person who recorded it. */
function doneBy(m: any): string {
  if (m.repaired_by) return m.repaired_by;
  return [m.technician?.rank, m.technician?.first_name, m.technician?.last_name].filter(Boolean).join(" ") || "—";
}
