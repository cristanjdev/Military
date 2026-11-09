"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Download,
  Crosshair,
  History,
  Wrench,
  Loader2,
  Copy,
  Check,
  Printer,
  ShieldCheck,
  ShieldAlert,
  UserCheck,
  RotateCcw,
  Calendar,
  Layers,
  MapPin,
  Clock,
  Shield,
  Barcode,
  ExternalLink,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { CONDITIONS, STATUSES, fmtDate, PURPOSES } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";
import { useAuthStore, hasRole } from "@/store/auth";
import { PasswordConfirmModal } from "@/components/ui/password-confirm-modal";
import { EditFirearmModal } from "@/components/firearms/edit-firearm-modal";
import { ReleaseHistory } from "@/components/firearms/release-history";

export default function FirearmDetailPage() {
  const router = useRouter();
  const { id } = useParams() as { id: string };
  const user = useAuthStore((s) => s.user);
  // Issue / return buttons: only the Armory Custodian releases and receives firearms.
  const canManage = hasRole(user, "Administrator", "Armory Custodian");
  // Edit / delete the record: the inventory roles the API allows (the Command Officer only views).
  const canEditInventory = hasRole(user, "Administrator", "S4 Officer", "Armory Custodian");
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["firearm", id],
    queryFn: async () => (await api.get(`/firearms/${id}`)).data,
  });

  async function loadQr() {
    setQrLoading(true);
    try {
      const resp = await api.get(`/firearms/${id}/qr`, { responseType: "text" });
      setQrSvg(resp.data);
    } catch {
      // ignore
    } finally {
      setQrLoading(false);
    }
  }

  useEffect(() => {
    if (id) {
      loadQr();
    }
  }, [id]);

  function copyText(text: string, label: string, fieldKey: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedField(fieldKey);
      toast.success(`${label} copied to clipboard`);
      setTimeout(() => setCopiedField(null), 2000);
    }
  }

  function handlePrintTag() {
    if (typeof window !== "undefined") {
      window.print();
    }
  }

  function formatPersonnel(
    person?: { rank?: string | null; first_name?: string; last_name?: string } | null,
    fallbackId?: number | null
  ) {
    if (!person) return fallbackId ? `#${fallbackId}` : "—";
    const rank = person.rank ? `${person.rank} ` : "";
    const name = `${person.first_name || ""} ${person.last_name || ""}`.trim();
    return `${rank}${name}`.trim() || (fallbackId ? `#${fallbackId}` : "—");
  }

  if (isError) return <DataError onRetry={refetch} />;
  if (isLoading || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[360px] gap-3 text-steel-400">
        <Loader2 className="h-8 w-8 animate-spin text-olive-400" />
        <span className="text-sm font-mono tracking-wider">RETRIEVING ARMORY DOSSIER…</span>
      </div>
    );
  }

  // Identify active or overdue assignment
  const activeTx = data.transactions?.find(
    (t: any) => t.status === "Active" || t.status === "Overdue"
  );

  return (
    <div className="space-y-6">
      {/* Top Header & Quick Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.back()}
            className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5 border border-steel-700/60 rounded-md"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Registry
          </button>
          <span className="text-steel-600">/</span>
          <span className="text-xs font-mono text-olive-400 bg-steel-900/80 px-2 py-0.5 rounded border border-steel-700/50">
            {data.serial_number}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {canManage && data.availability_status === 1 && (
            <Link
              href={`/transactions?action=issue&equipment_id=${data.equipment_id}`}
              className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Issue Weapon
            </Link>
          )}

          {canManage && (data.availability_status === 2 || data.availability_status === 4) && (
            <Link
              href={`/scan?lookup=${encodeURIComponent(data.serial_number)}`}
              className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Process Return
            </Link>
          )}

          <button
            onClick={handlePrintTag}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
            title="Print official AFP armory asset tag"
          >
            <Printer className="h-3.5 w-3.5 text-steel-300" /> Print Tag
          </button>

          <a
            href={`/gps?equipment_id=${id}`}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
          >
            <Crosshair className="h-3.5 w-3.5 text-olive-400" /> Map
          </a>

          {canEditInventory && (
            <button
              onClick={() => setEditing(true)}
              className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
            >
              <Pencil className="h-3.5 w-3.5 text-steel-300" /> Edit
            </button>
          )}

          {canEditInventory && (
            <button
              onClick={() => setDeleting(true)}
              disabled={data.availability_status === 2 || data.availability_status === 4}
              title={
                data.availability_status === 2 || data.availability_status === 4
                  ? "Return the firearm before deleting it"
                  : "Delete this firearm"
              }
              className="btn-danger text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          )}
        </div>
      </div>

      {/* Main Responsive Dossier Grid - Heights Equalized */}
      <div className="grid lg:grid-cols-12 gap-5 items-stretch print:hidden">
        {/* Left Column: Weapon Specification Dossier */}
        <div className="lg:col-span-7 xl:col-span-8 glass rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-5">
            {/* Header & Badges */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 border-b border-steel-800 pb-4">
              <div>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded bg-steel-900 border border-olive-500/30 text-olive-300 font-semibold">
                    {data.category?.category_name ?? "FIREARM"}
                  </span>
                  <span className={`pill ${CONDITIONS[data.condition_status]?.tone}`}>
                    {CONDITIONS[data.condition_status]?.label}
                  </span>
                  <span className={`pill ${STATUSES[data.availability_status]?.tone}`}>
                    {STATUSES[data.availability_status]?.label}
                  </span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold text-olive-50 tracking-tight">
                  {data.model}
                </h1>
                <p className="text-xs text-steel-400 mt-0.5 font-mono">
                  {data.manufacturer} · Caliber {data.caliber ?? "Standard"}
                </p>
              </div>

              {/* Copyable Identifiers */}
              <div className="flex flex-col gap-1.5 self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => copyText(data.serial_number, "Serial Number", "sn")}
                  className="flex items-center justify-between gap-2 px-2.5 py-1 rounded bg-steel-900/80 border border-steel-700/70 hover:border-olive-500/60 transition-colors text-left"
                  title="Click to copy Serial Number"
                >
                  <span className="text-[10px] uppercase tracking-wider text-steel-400 font-mono">SN:</span>
                  <span className="text-xs font-mono font-bold text-olive-200">{data.serial_number}</span>
                  {copiedField === "sn" ? (
                    <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                  ) : (
                    <Copy className="h-3 w-3 text-steel-500 shrink-0" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => copyText(data.qr_code, "QR Asset Hash", "qr")}
                  className="flex items-center justify-between gap-2 px-2.5 py-1 rounded bg-steel-900/80 border border-steel-700/70 hover:border-olive-500/60 transition-colors text-left"
                  title="Click to copy QR Asset Hash"
                >
                  <span className="text-[10px] uppercase tracking-wider text-steel-400 font-mono">TAG:</span>
                  <span className="text-xs font-mono text-steel-300 truncate max-w-[160px] sm:max-w-[210px]">{data.qr_code}</span>
                  {copiedField === "qr" ? (
                    <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                  ) : (
                    <Copy className="h-3 w-3 text-steel-500 shrink-0" />
                  )}
                </button>
              </div>
            </div>

            {/* Custody / Operational Status Alert Banner */}
            {activeTx ? (
              <div
                className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
                  activeTx.status === "Overdue"
                    ? "bg-red-950/25 border-red-500/40 text-red-200"
                    : "bg-steel-900/60 border-steel-700/60 text-steel-300"
                }`}
              >
                <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                  {activeTx.status === "Overdue" ? (
                    <ShieldAlert className="h-4 w-4 text-red-400 animate-pulse shrink-0" />
                  ) : (
                    <UserCheck className="h-4 w-4 text-tactical-accent shrink-0" />
                  )}
                  <span className="text-steel-400">Issued to:</span>
                  <span className="font-semibold text-white">
                    {formatPersonnel(activeTx.user, activeTx.user_id)}
                  </span>
                  <span
                    className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${
                      activeTx.status === "Overdue"
                        ? "bg-red-500/20 text-red-300 border border-red-500/40"
                        : "bg-steel-800 text-steel-300 border border-steel-700"
                    }`}
                  >
                    {PURPOSES[activeTx.purpose] ?? "Active"}
                  </span>
                  <span className="text-steel-600">·</span>
                  <span className="text-steel-400">
                    Out: {fmtDate(activeTx.checkout_at)}
                  </span>
                  {activeTx.expected_return_at && (
                    <>
                      <span className="text-steel-600">·</span>
                      <span className={activeTx.status === "Overdue" ? "text-red-300 font-semibold" : "text-steel-400"}>
                        Due: {fmtDate(activeTx.expected_return_at)}
                      </span>
                    </>
                  )}
                  {activeTx.authorizer && (
                    <>
                      <span className="text-steel-600">·</span>
                      <span className="text-steel-400">
                        Auth: {formatPersonnel(activeTx.authorizer, activeTx.authorized_by)}
                      </span>
                    </>
                  )}
                </div>

                {canManage && (
                  <Link
                    href={`/scan?lookup=${encodeURIComponent(data.serial_number)}`}
                    className={`btn text-xs py-1 px-3 h-8 shrink-0 self-start sm:self-auto flex items-center gap-1.5 ${
                      activeTx.status === "Overdue"
                        ? "btn-danger"
                        : "btn-secondary border-steel-700 hover:border-olive-500 text-steel-200"
                    }`}
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-steel-400" /> Process Return
                  </Link>
                )}
              </div>
            ) : data.availability_status === 1 ? (
              <div className="p-3 rounded-xl border bg-steel-900/60 border-steel-700/60 text-steel-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>
                    Secured in <strong className="text-white font-medium">{data.current_location?.location_name ?? "10RCDG Main Armory"}</strong> · Ready for issuance
                  </span>
                </div>
                {canManage && (
                  <Link
                    href={`/transactions?action=issue&equipment_id=${data.equipment_id}`}
                    className="btn-primary text-xs py-1 px-3 h-8 shrink-0 self-start sm:self-auto flex items-center gap-1.5"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Issue Weapon
                  </Link>
                )}
              </div>
            ) : (
              <div className="p-3 rounded-xl border bg-amber-950/20 border-amber-600/30 flex items-center gap-2.5 text-xs text-amber-200">
                <Wrench className="h-4 w-4 text-amber-400 shrink-0" />
                <span>
                  Armory Maintenance Protocol · Servicing at <strong className="text-white font-medium">{data.current_location?.location_name ?? "Armory Workshop"}</strong>
                </span>
              </div>
            )}

            {/* Specifications Tactical Matrix */}
            <div>
              <p className="section-title mb-3">Technical Specifications</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <SpecCell label="Manufacturer" value={data.manufacturer} />
                <SpecCell label="Caliber" value={data.caliber ?? "—"} />
                <SpecCell label="Category" value={data.category?.category_name ?? "Firearm"} />
                <SpecCell label="Assigned Location" value={data.current_location?.location_name ?? "—"} />
                <SpecCell
                  label="Condition State"
                  value={
                    <span className={`pill ${CONDITIONS[data.condition_status]?.tone}`}>
                      {CONDITIONS[data.condition_status]?.label}
                    </span>
                  }
                />
                <SpecCell
                  label="Armory Status"
                  value={
                    <span className={`pill ${STATUSES[data.availability_status]?.tone}`}>
                      {STATUSES[data.availability_status]?.label}
                    </span>
                  }
                />
                <SpecCell label="Date Acquired" value={fmtDate(data.acquisition_date, "yyyy-MM-dd")} />
                <SpecCell
                  label="Acquisition Cost"
                  value={`PHP ${Number(data.acquisition_cost || 0).toLocaleString()}`}
                />
                <SpecCell
                  label="Next Maintenance"
                  value={data.next_maintenance_due ? fmtDate(data.next_maintenance_due, "yyyy-MM-dd") : "On Schedule"}
                />
              </div>
            </div>
          </div>

          {/* Quick Action Navigation Buttons */}
          <div className="pt-4 border-t border-steel-800 flex flex-wrap gap-2.5">
            <Link
              href={`/gps?equipment_id=${id}`}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
            >
              <Crosshair className="h-3.5 w-3.5 text-olive-400" /> Tactical GPS Map
            </Link>
            <Link
              href={`/transactions?equipment_id=${id}`}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
            >
              <History className="h-3.5 w-3.5 text-steel-400" /> Transaction Ledger
            </Link>
            <Link
              href={`/maintenance?equipment_id=${id}`}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
            >
              <Wrench className="h-3.5 w-3.5 text-amber-400" /> Maintenance Records
            </Link>
          </div>
        </div>

        {/* Right Column: Tactical Military QR Asset Tag & Print Station */}
        <div className="lg:col-span-5 xl:col-span-4 glass rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-steel-800 pb-3">
              <div>
                <p className="section-title">QR Asset Tag</p>
                <p className="text-[11px] text-steel-400">Scannable 2D Armory Identification</p>
              </div>
              <span className="text-[10px] font-mono uppercase bg-steel-900/90 text-tactical-accent border border-tactical-accent/40 px-2 py-0.5 rounded">
                MIL-STD 130N
              </span>
            </div>

            {/* Official Military Armory Tag Display Plate */}
            <div
              id="printable-asset-plate"
              className="bg-steel-950 border-2 border-olive-700/60 rounded-xl p-4 shadow-2xl relative overflow-hidden flex flex-col items-center text-center"
            >
              {/* Corner Tactical Tick Accents */}
              <div className="absolute top-1.5 left-1.5 w-2.5 h-2.5 border-t-2 border-l-2 border-tactical-accent/80" />
              <div className="absolute top-1.5 right-1.5 w-2.5 h-2.5 border-t-2 border-r-2 border-tactical-accent/80" />
              <div className="absolute bottom-1.5 left-1.5 w-2.5 h-2.5 border-b-2 border-l-2 border-tactical-accent/80" />
              <div className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 border-b-2 border-r-2 border-tactical-accent/80" />

              {/* Tag Header */}
              <div className="mb-2">
                <p className="text-[10px] font-bold tracking-[0.2em] text-olive-300 uppercase">
                  PHILIPPINE ARMY · 10RCDG ARMORY
                </p>
                <p className="text-[9px] uppercase tracking-wider text-steel-400">
                  Official Property Identification Plate
                </p>
              </div>

              {/* QR Mounting Base Plate */}
              <div className="w-full max-w-[210px] aspect-square bg-white p-2.5 rounded-lg shadow-inner flex items-center justify-center relative my-1">
                {qrLoading ? (
                  <div className="flex flex-col items-center gap-2 text-steel-700 text-xs">
                    <Loader2 className="h-6 w-6 animate-spin text-olive-600" />
                    <span className="font-mono text-[10px] uppercase font-semibold">Generating…</span>
                  </div>
                ) : qrSvg ? (
                  <div
                    className="w-full h-full flex items-center justify-center [&>svg]:w-full [&>svg]:h-full [&>svg]:block"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                ) : (
                  <button onClick={loadQr} className="btn-primary text-xs py-1.5 px-3">
                    <Download className="h-3.5 w-3.5" /> Generate QR
                  </button>
                )}
              </div>

              {/* Tag Footer Metadata */}
              <div className="mt-3 w-full border-t border-steel-800/80 pt-2 space-y-1">
                <p className="text-xs font-mono font-bold text-olive-200 tracking-wider">
                  SN: {data.serial_number}
                </p>
                <p className="text-[11px] font-medium text-steel-300">
                  {data.model} {data.caliber ? `· ${data.caliber}` : ""}
                </p>
                <div className="pt-1">
                  <span className="inline-block text-[9px] font-mono text-steel-400 bg-steel-900/90 px-2 py-0.5 rounded border border-steel-800 break-all select-all">
                    {data.qr_code}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Asset Tag Action Utility Toolbar */}
          <div className="space-y-2 pt-2 border-t border-steel-800">
            <div className="grid grid-cols-2 gap-2">
              {qrSvg && (
                <a
                  className="btn-secondary text-xs py-2 flex items-center justify-center gap-1.5"
                  download={`armory-${data.serial_number}.svg`}
                  href={`data:image/svg+xml;base64,${
                    typeof window === "undefined"
                      ? ""
                      : btoa(unescape(encodeURIComponent(qrSvg)))
                  }`}
                  title="Download vector SVG for armory engraving or sticker print"
                >
                  <Download className="h-3.5 w-3.5 text-steel-300" /> Download SVG
                </a>
              )}
              <button
                type="button"
                onClick={handlePrintTag}
                className="btn-secondary text-xs py-2 flex items-center justify-center gap-1.5"
              >
                <Printer className="h-3.5 w-3.5 text-steel-300" /> Print Label
              </button>
            </div>

            <button
              type="button"
              onClick={() => copyText(data.qr_code, "QR Asset Payload", "qr-btn")}
              className="w-full btn-ghost text-xs py-1.5 flex items-center justify-center gap-1.5 text-steel-400 hover:text-steel-200 border border-steel-800 rounded-md"
            >
              {copiedField === "qr-btn" ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-mono">Payload Hash Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy Asset Tag Hash</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Assignment History Section */}
      <div className="glass rounded-xl p-6 space-y-4 print:hidden">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-steel-800 pb-3">
          <div>
            <h2 className="text-base font-bold text-olive-50 flex items-center gap-2">
              <History className="h-4 w-4 text-olive-400" /> Assignment History
            </h2>
            <p className="text-xs text-steel-400">
              Recorded custody handovers, mission assignments, and armory returns
            </p>
          </div>
          <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-steel-900 border border-steel-700/60 text-olive-300 self-start sm:self-auto">
            {data.transactions?.length || 0} Records
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-olive-300 border-b border-steel-800">
                <th className="text-left py-2 px-3 font-semibold">Tx ID</th>
                <th className="text-left py-2 px-3 font-semibold">Personnel (Custodian)</th>
                <th className="text-left py-2 px-3 font-semibold">Authorized By</th>
                <th className="text-center py-2 px-3 font-semibold">Purpose</th>
                <th className="text-center py-2 px-3 font-semibold">Checkout Time</th>
                <th className="text-center py-2 px-3 font-semibold">Return Time</th>
                <th className="text-center py-2 px-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions?.map((t: any) => (
                <tr
                  key={t.transaction_id}
                  className="border-b border-steel-800/60 hover:bg-steel-800/30 transition-colors"
                >
                  <td className="font-mono text-olive-300 py-3 px-3 font-semibold">
                    #{t.transaction_id}
                  </td>
                  <td className="py-3 px-3 text-steel-100 font-medium">
                    {formatPersonnel(t.user, t.user_id)}
                  </td>
                  <td className="py-3 px-3 text-steel-300 text-xs font-medium">
                    {formatPersonnel(t.authorizer, t.authorized_by)}
                  </td>
                  <td className="text-center py-3 px-3 text-xs">
                    <span className="inline-block px-2 py-0.5 rounded bg-steel-900/80 border border-steel-700/50 text-steel-200">
                      {PURPOSES[t.purpose] ?? "Deployment"}
                    </span>
                  </td>
                  <td className="text-center py-3 px-3 text-xs font-mono text-steel-300">
                    {fmtDate(t.checkout_at)}
                  </td>
                  <td className="text-center py-3 px-3 text-xs font-mono text-steel-400">
                    {t.actual_return_at ? (
                      fmtDate(t.actual_return_at)
                    ) : (
                      <span className="text-blue-400 font-sans italic">Active Custody</span>
                    )}
                  </td>
                  <td className="text-center py-3 px-3">
                    <span
                      className={`pill pill-${
                        t.status === "Active"
                          ? "info"
                          : t.status === "Overdue"
                          ? "critical"
                          : "ok"
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                </tr>
              ))}

              {(!data.transactions || data.transactions.length === 0) && (
                <tr>
                  <td colSpan={7} className="text-steel-500 py-8 text-center text-xs">
                    No assignment or checkout transactions logged for this weapon yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {data.transactions !== undefined && <ReleaseHistory firearm={data} />}

      {/* Dedicated Print-Only View for Thermal / Label Printing */}
      <div className="hidden print:block print:p-6 print:m-auto print:max-w-md print:text-black">
        <div className="border-2 border-black p-4 rounded text-center space-y-3">
          <div className="border-b border-black pb-2">
            <h1 className="text-sm font-bold uppercase tracking-wider">
              ARMED FORCES OF THE PHILIPPINES
            </h1>
            <h2 className="text-xs font-bold uppercase tracking-wider">
              PHILIPPINE ARMY · 10RCDG ARMORY
            </h2>
            <p className="text-[10px] tracking-widest uppercase">
              MIL-STD 130N ASSET IDENTIFICATION
            </p>
          </div>

          <div className="w-48 h-48 mx-auto p-1 flex items-center justify-center">
            {qrSvg && (
              <div
                className="w-full h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:block"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            )}
          </div>

          <div className="border-t border-black pt-2 text-left text-xs space-y-1 font-mono">
            <div><strong>MODEL:</strong> {data.model}</div>
            <div><strong>SERIAL NO:</strong> {data.serial_number}</div>
            <div><strong>CALIBER:</strong> {data.caliber ?? "Standard"}</div>
            <div><strong>QR HASH:</strong> {data.qr_code}</div>
            <div><strong>ARMORY:</strong> {data.current_location?.location_name ?? "10RCDG Main"}</div>
          </div>
        </div>
      </div>

      {editing && (
        <EditFirearmModal
          firearm={data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refetch();
            qc.invalidateQueries({ queryKey: ["firearms"] });
          }}
        />
      )}

      <PasswordConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={async (password) => {
          await api.delete(`/firearms/${data.equipment_id}`, { data: { password } });
          toast.success(`Deleted ${data.serial_number}`);
          qc.invalidateQueries({ queryKey: ["firearms"] });
          qc.invalidateQueries({ queryKey: ["available-firearms"] });
          router.replace("/firearms");
        }}
        title="Delete Firearm"
        description={`Delete ${data.serial_number} (${data.model})? It disappears from the registry and from every Select Firearm list. Its past transactions stay in the records.`}
      />
    </div>
  );
}

function SpecCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-steel-900/60 border border-steel-800/80 rounded-lg p-3 hover:border-olive-600/30 transition-colors">
      <p className="text-[10px] uppercase tracking-widest text-olive-300 font-semibold mb-1">
        {label}
      </p>
      <div className="text-sm font-medium text-steel-100">{value}</div>
    </div>
  );
}
