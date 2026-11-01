"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, Loader2, Shield } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

export default function NewFirearmPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const { data: categoryList } = useQuery({
    queryKey: ["equipment-categories"],
    queryFn: async () => (await api.get("/categories")).data,
  });

  const { data: locations } = useQuery({
    queryKey: ["locations"],
    queryFn: async () => (await api.get("/locations")).data,
  });

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

  function set<K extends keyof typeof form>(k: K, v: any) {
    setForm((f) => ({ ...f, [k]: v }));
  }

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
      router.replace(`/firearms/${data.equipment_id}`);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Failed to register firearm.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <button onClick={() => router.back()} className="btn-ghost text-xs"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>

      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-xl p-6 space-y-4"
      >
        <div>

          <h1 className="text-2xl font-bold text-olive-50">Register Firearm</h1>
          <p className="text-sm text-steel-400">A unique QR code is generated automatically.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Serial Number" required>
            <input className="input-field" required value={form.serial_number}
                   onChange={(e) => set("serial_number", e.target.value.toUpperCase())} />
          </Field>
          <Field label="Model" required>
            <input className="input-field" required value={form.model} onChange={(e) => set("model", e.target.value)} />
          </Field>
          <Field label="Manufacturer" required>
            <input className="input-field" required value={form.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} />
          </Field>
          <Field label="Caliber">
            <input className="input-field" value={form.caliber} onChange={(e) => set("caliber", e.target.value)} />
          </Field>
          <Field label="Category" required>
            <select className="input-field" required value={form.category_id} onChange={(e) => set("category_id", Number(e.target.value))}>
              {categoryList?.map((c: any) => (
                <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Condition" required>
            <select className="input-field" value={form.condition_status} onChange={(e) => set("condition_status", Number(e.target.value))}>
              <option value={1}>Excellent</option>
              <option value={2}>Good</option>
              <option value={3}>Fair</option>
              <option value={4}>Poor</option>
            </select>
          </Field>
          <Field label="Initial Location">
            <select className="input-field" value={form.current_location_id}
                    onChange={(e) => set("current_location_id", e.target.value)}>
              <option value="">— None —</option>
              {locations?.map((l: any) => (
                <option key={l.location_id} value={l.location_id}>{l.location_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Acquisition Date" required>
            <input className="input-field" type="date" required value={form.acquisition_date}
                   onChange={(e) => set("acquisition_date", e.target.value)} />
          </Field>
          <Field label="Acquisition Cost (PHP)" required>
            <input className="input-field" type="number" min={0} step="0.01" required placeholder="0.00"
                   value={form.acquisition_cost}
                   onChange={(e) => set("acquisition_cost", e.target.value)} />
          </Field>
        </div>

        <Field label="Remarks">
          <textarea className="input-field h-24" value={form.remarks} onChange={(e) => set("remarks", e.target.value)} />
        </Field>

        <button disabled={loading} className="btn-primary">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Register Firearm
        </button>
      </motion.form>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-olive-300">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
