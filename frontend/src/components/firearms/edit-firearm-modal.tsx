"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface Firearm {
  equipment_id: number;
  serial_number: string;
  category_id: number;
  model: string;
  manufacturer: string;
  caliber?: string | null;
  condition_status: number;
  current_location_id?: number | null;
  remarks?: string | null;
}

/**
 * Edits a firearm's details. The serial number stays fixed (the QR code is built from it),
 * and availability changes only through issuance, return and maintenance.
 */
export function EditFirearmModal({ firearm, onClose, onSaved }: { firearm: Firearm; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    category_id: firearm.category_id,
    model: firearm.model ?? "",
    manufacturer: firearm.manufacturer ?? "",
    caliber: firearm.caliber ?? "",
    condition_status: firearm.condition_status,
    current_location_id: firearm.current_location_id ? String(firearm.current_location_id) : "",
    remarks: firearm.remarks ?? "",
  });
  const [saving, setSaving] = useState(false);

  const { data: categories } = useQuery({
    queryKey: ["equipment-categories"],
    queryFn: async () => (await api.get("/categories")).data,
  });
  const { data: locations } = useQuery({
    queryKey: ["locations-for-register"],
    queryFn: async () => (await api.get("/locations")).data,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/firearms/${firearm.equipment_id}`, {
        ...form,
        caliber: form.caliber || null,
        remarks: form.remarks || null,
        current_location_id: form.current_location_id ? Number(form.current_location_id) : null,
      });
      toast.success(`Updated ${firearm.serial_number}`);
      onSaved();
    } catch (err: any) {
      const errors = err.response?.data?.errors as Record<string, string[]> | undefined;
      toast.error((errors ? Object.values(errors)[0]?.[0] : undefined) ?? err.response?.data?.message ?? "Failed to update firearm.");
    } finally {
      setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { if (!saving) onClose(); }}>
      <div className="glass rounded-xl p-5 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-labelledby="edit-firearm-title">
        <form onSubmit={submit} className="space-y-3">
          <div className="flex justify-between items-center">
            <p id="edit-firearm-title" className="section-title">Edit Firearm · {firearm.serial_number}</p>
            <button type="button" onClick={onClose} disabled={saving} className="btn-ghost text-xs" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
          </div>
          <p className="text-xs text-steel-400">The serial number cannot be changed because the QR code is built from it.</p>

          <div className="grid md:grid-cols-2 gap-3">
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
            <div>
              <label className="text-xs text-steel-400 mb-1 block">Category <span className="text-red-400">*</span></label>
              <select className="input-field w-full h-[42px]" required value={form.category_id}
                      onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}>
                {categories?.map((c: any) => (
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

          <div>
            <label className="text-xs text-steel-400 mb-1 block">Remarks</label>
            <textarea className="input-field w-full h-16" placeholder="Optional notes" value={form.remarks}
                      onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </div>

          <div className="flex gap-2 justify-end pt-3">
            <button type="button" onClick={onClose} disabled={saving} className="btn-secondary text-xs">Cancel</button>
            <button disabled={saving} className="btn-primary text-xs">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
