"use client";

import Link from "next/link";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, ScanLine, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { CONDITIONS, STATUSES, fmtDate } from "@/lib/utils";
import { useAuthStore, hasRole } from "@/store/auth";
import { DataError } from "@/components/ui/data-error";

interface Firearm {
  equipment_id: number;
  serial_number: string;
  qr_code: string;
  model: string;
  manufacturer: string;
  caliber: string | null;
  condition_status: number;
  availability_status: number;
  acquisition_date: string;
  category: { category_name: string };
  current_location?: { location_name: string } | null;
}

export default function FirearmsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
  const [showRegister, setShowRegister] = useState(false);
  const user = useAuthStore((s) => s.user);
  const canCreate = hasRole(user, "Administrator", "S4 Officer", "Armory Custodian");
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["firearms", search, status],
    queryFn: async () => (await api.get("/firearms", {
      params: { search, availability_status: status || undefined, per_page: 50 },
    })).data,
  });

  const items: Firearm[] = data?.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50">Firearm Registry</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/scan" className="btn-secondary"><ScanLine className="h-4 w-4" /> QR Scan</Link>
          {canCreate && <button onClick={() => setShowRegister(true)} className="btn-primary"><Plus className="h-4 w-4" /> Register Firearm</button>}
        </div>
      </div>

      <div className="glass rounded-xl p-4">
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-steel-400" />
            <input
              className="input-field pl-9"
              placeholder="Search by serial, model, manufacturer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="input-field sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="1">Available</option>
            <option value="2">Checked Out</option>
            <option value="3">Maintenance</option>
            <option value="4">Overdue</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-olive-300">
                <th className="text-left py-2">Serial</th>
                <th className="text-center">Model</th>
                <th className="text-center">Manufacturer</th>
                <th className="text-center">Caliber</th>
                <th className="text-center">Condition</th>
                <th className="text-center">Status</th>
                <th className="text-center">Location</th>
                <th className="text-center">Acquired</th>
              </tr>
            </thead>
            <tbody>
              {isError && <tr><td colSpan={8} className="py-0"><DataError onRetry={refetch} /></td></tr>}
              {isLoading && !isError && <tr><td colSpan={8} className="text-center text-steel-400 py-6">Loading…</td></tr>}
              {!isLoading && items.length === 0 && <tr><td colSpan={8} className="text-center text-steel-500 py-6">No firearms match your filter.</td></tr>}
              {items.map((f) => (
                <tr key={f.equipment_id} className="border-t border-steel-800 hover:bg-steel-800/30">
                  <td className="py-2 font-mono text-olive-200">
                    <Link href={`/firearms/${f.equipment_id}`}>{f.serial_number}</Link>
                  </td>
                  <td className="text-center text-steel-100">{f.model}</td>
                  <td className="text-center text-steel-300">{f.manufacturer}</td>
                  <td className="text-center text-steel-300">{f.caliber ?? "—"}</td>
                  <td className="text-center"><span className={`pill ${CONDITIONS[f.condition_status]?.tone}`}>{CONDITIONS[f.condition_status]?.label}</span></td>
                  <td className="text-center"><span className={`pill ${STATUSES[f.availability_status]?.tone}`}>{STATUSES[f.availability_status]?.label}</span></td>
                  <td className="text-center text-steel-400 text-xs">{f.current_location?.location_name ?? "—"}</td>
                  <td className="text-center text-steel-400 text-xs">{fmtDate(f.acquisition_date, "yyyy-MM-dd")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Register Firearm Modal */}
      {showRegister && <RegisterFirearmModal onClose={() => setShowRegister(false)} onSuccess={() => {
        setShowRegister(false);
        qc.invalidateQueries({ queryKey: ["firearms"] });
      }} />}
    </div>
  );
}

/* -------------- Register Firearm Modal -------------- */
function RegisterFirearmModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({
    category_id: 1,
    serial_number: "",
    model: "",
    manufacturer: "",
    caliber: "",
    condition_status: 2,
    current_location_id: "",
    acquisition_date: new Date().toISOString().substring(0, 10),
    acquisition_cost: "",
    remarks: "",
  });
  const [loading, setLoading] = useState(false);

  const { data: categoryList } = useQuery({
    queryKey: ["equipment-categories"],
    queryFn: async () => (await api.get("/categories")).data,
  });

  const { data: locations } = useQuery({
    queryKey: ["locations-for-register"],
    queryFn: async () => (await api.get("/locations")).data,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        ...form,
        acquisition_cost: Number(form.acquisition_cost),
        current_location_id: form.current_location_id || null,
      };
      const { data } = await api.post("/firearms", payload);
      toast.success(`Registered ${data.serial_number}`);
      onSuccess();
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Failed to register firearm.");
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="glass rounded-xl p-5 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex justify-between items-center">
            <p className="section-title">Register Firearm</p>
            <button type="button" onClick={onClose} className="btn-ghost text-xs"><X className="h-3.5 w-3.5" /></button>
          </div>
          <p className="text-xs text-steel-400">A unique QR code is generated automatically upon registration.</p>

          {/* Identification */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-1.5">Identification</p>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Serial Number <span className="text-red-400">*</span></label>
                <input className="input-field w-full h-[42px]" required value={form.serial_number}
                       onChange={(e) => setForm({ ...form, serial_number: e.target.value.toUpperCase() })} />
              </div>
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Model <span className="text-red-400">*</span></label>
                <input className="input-field w-full h-[42px]" required value={form.model}
                       onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Manufacturer <span className="text-red-400">*</span></label>
                <input className="input-field w-full h-[42px]" required value={form.manufacturer}
                       onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Caliber</label>
                <input className="input-field w-full h-[42px]" value={form.caliber}
                       onChange={(e) => setForm({ ...form, caliber: e.target.value })} />
              </div>
            </div>
          </div>

          {/* Classification & Condition */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-1.5">Classification & Condition</p>
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Category <span className="text-red-400">*</span></label>
                <select className="input-field w-full h-[42px]" required value={form.category_id}
                        onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}>
                  {categoryList?.map((c: any) => (
                    <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Condition <span className="text-red-400">*</span></label>
                <select className="input-field w-full h-[42px]" value={form.condition_status}
                        onChange={(e) => setForm({ ...form, condition_status: Number(e.target.value) })}>
                  <option value={1}>Excellent</option>
                  <option value={2}>Good</option>
                  <option value={3}>Fair</option>
                  <option value={4}>Poor</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Location</label>
                <select className="input-field w-full h-[42px]" value={form.current_location_id}
                        onChange={(e) => setForm({ ...form, current_location_id: e.target.value })}>
                  <option value="">— None —</option>
                  {locations?.map((l: any) => (
                    <option key={l.location_id} value={l.location_id}>{l.location_name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Acquisition */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-olive-300 mb-1.5">Acquisition</p>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Date <span className="text-red-400">*</span></label>
                <input className="input-field w-full h-[42px]" type="date" required value={form.acquisition_date}
                       onChange={(e) => setForm({ ...form, acquisition_date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-steel-400 mb-1 block">Cost (PHP) <span className="text-red-400">*</span></label>
                <input className="input-field w-full h-[42px]" type="number" min={0} step="0.01" required placeholder="0.00"
                       value={form.acquisition_cost}
                       onChange={(e) => setForm({ ...form, acquisition_cost: e.target.value })} />
              </div>
            </div>
          </div>

          {/* Remarks */}
          <div>
            <label className="text-xs text-steel-400 mb-1 block">Remarks</label>
            <textarea className="input-field w-full h-16" placeholder="Optional notes" value={form.remarks}
                      onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </div>

          <div className="flex gap-2 justify-end pt-3">
            <button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button>
            <button disabled={loading} className="btn-primary text-xs">
              {loading && <Loader2 className="h-4 w-4 animate-spin" />} Register Firearm
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
