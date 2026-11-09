"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Wrench, Loader2, Calendar, AlertTriangle, CheckCircle, X, ChevronLeft, ChevronRight, Hammer } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fmtDate, fmtPeso, wholePesoInput, CONDITIONS, MAINTENANCE_RESULTS } from "@/lib/utils";
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
        </div>
        {canRecord && tab !== "repairs" && (
          <button onClick={() => setShowForm((s) => !s)} className="btn-primary"><Plus className="h-4 w-4" /> New Record</button>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 flex-wrap">
        <button
          onClick={() => setTab("repairs")}
          className={`px-4 py-2 rounded-md text-xs uppercase tracking-widest transition-all ${
            tab === "repairs" ? "bg-olive-700/40 text-olive-100 border border-olive-500/40" : "text-steel-400 hover:text-olive-200"
          }`}
        >
          <Hammer className="h-3.5 w-3.5 inline mr-1.5" /> Repairs
        </button>
        <button
          onClick={() => setTab("history")}
          className={`px-4 py-2 rounded-md text-xs uppercase tracking-widest transition-all ${
            tab === "history" ? "bg-olive-700/40 text-olive-100 border border-olive-500/40" : "text-steel-400 hover:text-olive-200"
          }`}
        >
          <Wrench className="h-3.5 w-3.5 inline mr-1.5" /> History
        </button>
        <button
          onClick={() => setTab("schedule")}
          className={`px-4 py-2 rounded-md text-xs uppercase tracking-widest transition-all ${
            tab === "schedule" ? "bg-olive-700/40 text-olive-100 border border-olive-500/40" : "text-steel-400 hover:text-olive-200"
          }`}
        >
          <Calendar className="h-3.5 w-3.5 inline mr-1.5" /> Schedule
        </button>
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

      {/* Schedule Tab */}
      {tab === "schedule" && (
        <div className="glass rounded-xl p-4">
          <p className="section-title mb-3 flex items-center gap-2"><Calendar className="h-4 w-4" /> Upcoming Maintenance Schedule</p>
          {upcomingMaintenance.length === 0 && (
            <p className="text-steel-400 text-sm py-4 text-center">No scheduled maintenance.</p>
          )}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {upcomingMaintenance.map((item: any) => (
              <div
                key={item.equipment_id}
                className={`rounded-lg border p-4 ${
                  item.is_overdue
                    ? "border-red-600/50 bg-red-900/10"
                    : item.days_until <= 3
                    ? "border-amber-600/50 bg-amber-900/10"
                    : "border-olive-700/30 bg-steel-900/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-olive-100 font-mono">{item.serial_number}</p>
                    <p className="text-xs text-steel-400">{item.model}</p>
                  </div>
                  {item.is_overdue ? (
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                  ) : item.days_until <= 3 ? (
                    <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-olive-400 shrink-0" />
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-steel-300">
                    Due: <span className={item.is_overdue ? "text-red-300 font-semibold" : "text-olive-200"}>
                      {fmtDate(item.due_date, "yyyy-MM-dd")}
                    </span>
                  </p>
                  <p className="text-xs text-steel-400">
                    {item.is_overdue
                      ? `Overdue by ${Math.abs(item.days_until)} day(s)`
                      : `In ${item.days_until} day(s)`}
                  </p>
                  <span className={`pill ${CONDITIONS[item.condition]?.tone}`}>
                    {CONDITIONS[item.condition]?.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History Tab */}
      {tab === "history" && (
        <div className="glass rounded-xl p-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-olive-300">
                <th className="text-left py-2.5">Date</th>
                <th className="text-center">Firearm</th>
                <th className="text-center">Type</th>
                <th className="text-center px-3">Description</th>
                <th className="text-center">Status After</th>
                <th className="text-center">Done By</th>
                <th className="text-center">Cost</th>
              </tr>
            </thead>
            <tbody>
              {isError && (
                <tr>
                  <td colSpan={7} className="py-0">
                    <DataError onRetry={refetch} />
                  </td>
                </tr>
              )}
              {isLoading && !isError && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-steel-400">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && !isError && (!data?.data || data.data.length === 0) && (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-steel-500 text-xs">
                    No maintenance records found.
                  </td>
                </tr>
              )}
              {data?.data?.map((m: any) => (
                <tr key={m.maintenance_id} className="border-t border-steel-800/50 hover:bg-steel-800/20 transition-colors">
                  <td className="py-2.5 text-xs text-steel-300 font-mono whitespace-nowrap">
                    {fmtDate(m.maintenance_date, "yyyy-MM-dd")}
                  </td>
                  <td className="text-center font-mono text-olive-100 text-xs font-semibold whitespace-nowrap">
                    {m.firearm?.serial_number ?? "—"}
                  </td>
                  <td className="text-center whitespace-nowrap">
                    <span className={`pill text-[10px] ${maintenanceTypePill(m.maintenance_type)}`}>
                      {m.maintenance_type}
                    </span>
                  </td>
                  <td className="text-center text-xs text-steel-200 max-w-md px-3 py-2 leading-relaxed truncate" title={m.description}>
                    {m.description}
                  </td>
                  <td className="text-center whitespace-nowrap">
                    <span className={`pill text-[10px] ${MAINTENANCE_RESULTS[m.result_status]?.tone ?? "pill-muted"}`}>
                      {MAINTENANCE_RESULTS[m.result_status]?.label ?? "—"}
                    </span>
                  </td>
                  <td className="text-center text-xs text-steel-300 whitespace-nowrap">
                    {m.repaired_by ? (
                      <span title={`Recorded by ${[m.technician?.rank, m.technician?.first_name, m.technician?.last_name].filter(Boolean).join(" ")}`}>
                        {m.repaired_by}
                      </span>
                    ) : (
                      <>
                        {m.technician?.rank ? `${m.technician.rank} ` : ""}
                        {m.technician?.first_name} {m.technician?.last_name}
                      </>
                    )}
                  </td>
                  <td className="text-center font-mono text-xs text-steel-300 whitespace-nowrap">
                    {Number(m.cost) > 0 ? fmtPeso(m.cost) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {data && data.last_page > 1 && (
            <div className="mt-4 flex items-center justify-between border-t border-steel-800/50 pt-4">
              <div className="text-xs text-steel-400">
                Showing <span className="font-medium text-steel-200">{data.from || 0}</span> to <span className="font-medium text-steel-200">{data.to || 0}</span> of <span className="font-medium text-steel-200">{data.total}</span> entries
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1 || isLoading}
                  className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-steel-400 font-mono">
                  Page {page} / {data.last_page}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(data.last_page, p + 1))}
                  disabled={page === data.last_page || isLoading}
                  className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
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

function maintenanceTypePill(type: string) {
  switch (type?.toLowerCase()) {
    case "inspection":
      return "pill-info";
    case "repair":
      return "pill-warn";
    case "cleaning":
      return "pill-ok";
    case "calibration":
      return "pill-tactical";
    default:
      return "pill-muted";
  }
}
