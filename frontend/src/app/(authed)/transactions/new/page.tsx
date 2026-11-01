"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { confirmBiometric, isBiometricCancelled } from "@/store/biometric-confirm";
import { DestinationSelect } from "@/components/transactions/destination-select";

function NewIssuanceContent() {
  const router = useRouter();
  const params = useSearchParams();
  const initialEquipment = params.get("equipment_id") ?? "";

  const [form, setForm] = useState({
    equipment_id: initialEquipment,
    user_id: "",
    expected_return_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16),
    purpose: 1,
    condition_on_issue: 2,
    destination_location_id: "",
    notes: "",
  });
  const [loading, setLoading] = useState(false);

  const { data: firearms } = useQuery({
    queryKey: ["available-firearms"],
    queryFn: async () => (await api.get("/firearms", { params: { availability_status: 1, per_page: 100 } })).data,
  });

  const { data: personnel } = useQuery({
    queryKey: ["personnel"],
    queryFn: async () => (await api.get("/transactions/personnel")).data,
    retry: false,
  });

  function set<K extends keyof typeof form>(k: K, v: any) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // Fresh fingerprint scan for this exact firearm (a no-op when biometrics are off).
      const grant = await confirmBiometric("issue", `equipment:${Number(form.equipment_id)}`);
      await api.post("/transactions/issue", {
        ...form,
        equipment_id: Number(form.equipment_id),
        user_id: Number(form.user_id),
        destination_location_id: Number(form.destination_location_id),
        ...(grant ? { biometric_grant: grant } : {}),
      });
      toast.success("Firearm issued — GPS tracking activated.");
      router.replace("/transactions");
    } catch (e: any) {
      if (isBiometricCancelled(e)) return;
      toast.error(e.response?.data?.message ?? "Issuance failed.");
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

          <h1 className="text-2xl font-bold text-olive-50">New Issuance</h1>
          <p className="text-sm text-steel-400">After approval, GPS tracking and audit logging are activated automatically. The firearm must stay at its destination for 90 minutes, then go straight back to camp.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Firearm" required>
            <select className="input-field" required value={form.equipment_id} onChange={(e) => set("equipment_id", e.target.value)}>
              <option value="">— Select firearm —</option>
              {firearms?.data?.map((f: any) => (
                <option key={f.equipment_id} value={f.equipment_id}>
                  {f.serial_number} · {f.model} ({f.manufacturer})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Personnel" required>
            <select className="input-field" required value={form.user_id} onChange={(e) => set("user_id", e.target.value)}>
              <option value="">— Select personnel —</option>
              {personnel?.data?.map((u: any) => (
                <option key={u.user_id} value={u.user_id}>{u.rank} {u.first_name} {u.last_name}</option>
              ))}
            </select>
          </Field>

          <Field label="Destination" required>
            <DestinationSelect value={form.destination_location_id} onChange={(v) => set("destination_location_id", v)} />
          </Field>

          <Field label="Expected Return" required>
            <input className="input-field" type="datetime-local" required value={form.expected_return_at}
                   onChange={(e) => set("expected_return_at", e.target.value)} />
          </Field>

          <Field label="Purpose" required>
            <select className="input-field" value={form.purpose} onChange={(e) => set("purpose", Number(e.target.value))}>
              <option value={1}>Training</option>
              <option value={5}>Funeral</option>
            </select>
          </Field>

          <Field label="Condition on Issue" required>
            <select className="input-field" value={form.condition_on_issue} onChange={(e) => set("condition_on_issue", Number(e.target.value))}>
              <option value={1}>Excellent</option>
              <option value={2}>Good</option>
              <option value={3}>Fair</option>
              <option value={4}>Poor</option>
            </select>
          </Field>
        </div>

        <Field label="Notes">
          <textarea className="input-field h-20" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <button disabled={loading} className="btn-primary">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Authorize Issuance
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

export default function Page() {
  return (
    <Suspense fallback={<div className="text-steel-300">Loading…</div>}>
      <NewIssuanceContent />
    </Suspense>
  );
}
