"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera,
  CameraOff,
  QrCode,
  ShieldCheck,
  ClipboardCheck,
  UploadCloud,
  Volume2,
  VolumeX,
  Copy,
  Check,
  RotateCcw,
  ExternalLink,
  Wrench,
  ArrowRight,
  Search,
  RefreshCw,
  SlidersHorizontal,
  History,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuthStore, hasRole } from "@/store/auth";
import { useQrCamera, type ScanFeedback } from "@/lib/use-qr-camera";
import { ScanDetectionOverlay } from "@/components/scan/scan-detection-overlay";
import { decodeQrFromFile } from "@/lib/qr-decoder";
import { CONDITIONS, STATUSES, cn, fmtDate, fmtRelative } from "@/lib/utils";

interface ActiveTransaction {
  transaction_id: number;
  status: string;
  checkout_at: string;
  expected_return_at: string;
  user?: {
    user_id: number;
    first_name: string;
    last_name: string;
    rank?: string;
  };
}

interface FirearmLookupResult {
  equipment_id: number;
  serial_number: string;
  model: string;
  manufacturer: string;
  caliber?: string;
  condition_status: number;
  availability_status: number;
  qr_code?: string;
  category?: {
    category_id: number;
    category_name: string;
  };
  current_location?: {
    location_id: number;
    location_name: string;
  };
  transactions?: ActiveTransaction[];
}

interface RecentScan {
  equipment_id: number;
  serial_number: string;
  model: string;
  availability_status: number;
  timestamp: string;
  data: FirearmLookupResult;
}

export default function ScanPage() {
  const router = useRouter();
  // Only the Armory Custodian releases and receives firearms.
  const canRelease = hasRole(useAuthStore((s) => s.user), "Administrator", "Armory Custodian");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Mode: "camera" | "file"
  const [mode, setMode] = useState<"camera" | "file">("camera");

  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // Lookup Result & Session History
  const [hit, setHit] = useState<FirearmLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [recentScans, setRecentScans] = useState<RecentScan[]>([]);
  const [copiedSerial, setCopiedSerial] = useState(false);

  // Sound Feedback via Web Audio API
  const playBeep = useCallback(() => {
    if (!soundEnabled || typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);

      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);

      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    } catch {}
  }, [soundEnabled]);

  // Handle successful lookup resolution
  const handleResolve = useCallback(
    (firearm: FirearmLookupResult) => {
      playBeep();
      setHit(firearm);
      toast.success(`Target Acquired: ${firearm.model} (${firearm.serial_number})`);

      setRecentScans((prev) => {
        const filtered = prev.filter((r) => r.equipment_id !== firearm.equipment_id);
        return [
          {
            equipment_id: firearm.equipment_id,
            serial_number: firearm.serial_number,
            model: firearm.model,
            availability_status: firearm.availability_status,
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            data: firearm,
          },
          ...filtered,
        ].slice(0, 10);
      });
    },
    [playBeep]
  );

  // Lookup by QR payload or raw serial string
  const performLookup = useCallback(
    async (payloadStr: string): Promise<ScanFeedback | undefined> => {
      const trimmed = payloadStr.trim();
      if (!trimmed) return;
      setLoading(true);
      try {
        const { data } = await api.post("/firearms/lookup", { qr_payload: trimmed });
        handleResolve(data);
        return { status: "success", label: `${data.serial_number} · ${data.model}` };
      } catch (e: any) {
        const message = e.response?.data?.message ?? "Firearm not found in database.";
        toast.error(message);
        return { status: "error", label: message };
      } finally {
        setLoading(false);
      }
    },
    [handleResolve]
  );

  // Live camera: start/stop is serialized inside the hook so tab switches, pausing and the
  // camera list loading can never strand a running webcam stream.
  const { scanning, detection, cameraError, cameras: availableCameras, selectedCameraId, selectCamera, pause, resume, retry } =
    useQrCamera({ viewportId: "qr-camera-viewport", active: mode === "camera", onDecode: performLookup, rearmMs: 1500 });

  // Handle image file scan
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      const decoded = await decodeQrFromFile(file);
      if (!decoded) throw new Error("No QR code found");
      await performLookup(decoded);
    } catch {
      toast.error("No valid QR code detected in the uploaded image.");
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Copy Serial Number
  function copySerial(serial: string) {
    navigator.clipboard.writeText(serial);
    setCopiedSerial(true);
    toast.success(`Copied ${serial} to clipboard`);
    setTimeout(() => setCopiedSerial(false), 2000);
  }

  // Active transaction details if checked out
  const activeTx = hit?.transactions && hit.transactions.length > 0 ? hit.transactions[0] : null;
  const isCheckedOut = hit?.availability_status === 2 || hit?.availability_status === 4;

  return (
    <>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-wide text-olive-50">Quick Response (QR) Scanner</h1>
            <span className="pill pill-tactical text-[11px] font-mono flex items-center gap-1 whitespace-nowrap shrink-0">
              <QrCode className="h-3 w-3" /> QR-ID 1.0
            </span>
          </div>
          <p className="text-xs text-steel-400 mt-1 max-w-prose">
            Browser-integrated optical QR code recognition for firearm identification, issuance, and return verification.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          {/* Sound Toggle */}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            title={soundEnabled ? "Audio alert: Enabled" : "Audio alert: Muted"}
            className={cn(
              "btn-secondary text-xs px-3 py-2 sm:py-1.5 flex items-center justify-center gap-1.5 transition-colors",
              soundEnabled ? "text-olive-300 border-olive-500/40" : "text-steel-500"
            )}
          >
            {soundEnabled ? <Volume2 className="h-3.5 w-3.5 text-olive-300" /> : <VolumeX className="h-3.5 w-3.5 text-steel-500" />}
            <span>{soundEnabled ? "Audio Beep" : "Muted"}</span>
          </button>

          {/* Batch Scan Navigation */}
          <Link href="/scan/inventory" className="btn-secondary text-xs px-3 py-2 sm:py-1.5 flex items-center justify-center gap-1.5">
            <ClipboardCheck className="h-3.5 w-3.5 text-tactical-accent" />
            <span>Batch Inventory</span>
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-12 gap-5 items-stretch">
        {/* LEFT COLUMN: SCANNER VIEWPORT & INPUT MODES (7 cols) */}
        <div className="lg:col-span-7 min-w-0">
          <div className="glass rounded-xl p-4 sm:p-5 lg:h-full">
            {/* Mode Switcher Tabs */}
            <div className="flex min-h-10 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
              <div className="grid grid-cols-2 gap-1.5 sm:flex sm:items-center bg-steel-900/90 p-1 rounded-lg border border-olive-700/30">
                <button
                  onClick={() => setMode("camera")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-all",
                    mode === "camera"
                      ? "bg-tactical-surface text-olive-100 shadow-sm border border-olive-500/50"
                      : "text-steel-400 hover:text-steel-200"
                  )}
                >
                  <Camera className="h-3.5 w-3.5" />
                  <span>Live Camera</span>
                </button>

                <button
                  onClick={() => setMode("file")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-all",
                    mode === "file"
                      ? "bg-tactical-surface text-olive-100 shadow-sm border border-olive-500/50"
                      : "text-steel-400 hover:text-steel-200"
                  )}
                >
                  <UploadCloud className="h-3.5 w-3.5" />
                  <span>Upload QR Image</span>
                </button>
              </div>

              {/* Status Indicator */}
              <div className="flex items-center gap-2 min-h-[26px]">
                {mode === "camera" && scanning && (
                  <span className="pill pill-tactical text-[10px] uppercase tracking-wider flex items-center gap-1 whitespace-nowrap">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span><span className="hidden sm:inline">Optical </span>Tracking Active</span>
                  </span>
                )}
                {mode === "file" && (
                  <span className="pill pill-info text-[10px] uppercase tracking-wider flex items-center gap-1 whitespace-nowrap">
                    <UploadCloud className="h-3 w-3" />
                    Image Decoder Ready
                  </span>
                )}
              </div>
            </div>

            {/* TAB 1: LIVE CAMERA VIEWPORT */}
            {/* Stays mounted (hidden) on the upload tab so a camera start in flight is never torn out of the DOM. */}
            <div className={cn("flex-col space-y-3", mode === "camera" ? "flex" : "hidden")}>
              <div className="relative aspect-[4/3] w-full max-h-[420px] mx-auto overflow-hidden rounded-lg bg-black border border-olive-700/50 shadow-inner flex items-center justify-center">
                {/* HTML5 QR Code Mount Target */}
                <div id="qr-camera-viewport" ref={containerRef} className="absolute inset-0 w-full h-full" />
                <ScanDetectionOverlay detection={detection} />

                {/* Clean Viewfinder & Scan Line Overlay */}
                {scanning && !cameraError && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 overflow-hidden">
                    <div className="relative w-full h-full max-w-xs max-h-64 sm:max-h-72 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] border border-yellow-500/40">
                      {/* Tactical Reticle Corners */}
                      <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-yellow-400 rounded-tl-lg z-20" />
                      <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-yellow-400 rounded-tr-lg z-20" />
                      <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-yellow-400 rounded-bl-lg z-20" />
                      <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-yellow-400 rounded-br-lg z-20" />

                      {/* Sweeping Laser Beam with Glowing Core & Aura */}
                      <div className="absolute left-0 right-0 h-1 bg-gradient-to-r from-yellow-400 via-white to-yellow-400 animate-laser z-10 shadow-[0_0_18px_4px_rgba(250,204,21,1)]">
                        <div className="absolute left-0 right-0 -top-8 h-8 bg-gradient-to-b from-transparent to-yellow-400/25 pointer-events-none" />
                        <div className="absolute left-0 right-0 top-1 h-8 bg-gradient-to-t from-transparent to-yellow-400/25 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Camera Error / Standby Overlay */}
                {cameraError && (
                  <div className="p-6 text-center space-y-3 z-10 max-w-sm">
                    <div className="h-10 w-10 mx-auto rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                      <CameraOff className="h-5 w-5" />
                    </div>
                    <p className="text-xs text-steel-300">{cameraError}</p>
                    <div className="flex gap-2 justify-center pt-2">
                      <button onClick={retry} className="btn-secondary text-xs">
                        <RefreshCw className="h-3 w-3" /> Retry
                      </button>
                      <button onClick={() => setMode("file")} className="btn-primary text-xs">
                        Upload QR Image
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Camera Hardware Controls */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                {availableCameras.length > 1 && (
                  <div className="flex items-center gap-1.5 min-w-0 flex-1 sm:flex-none">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-steel-400" />
                    <select
                      value={selectedCameraId}
                      onChange={(e) => selectCamera(e.target.value)}
                      className="bg-steel-800 border border-olive-700/40 rounded px-2 py-1.5 sm:py-1 text-xs text-olive-100 min-w-0 flex-1 sm:flex-none truncate"
                    >
                      {availableCameras.map((cam) => (
                        <option key={cam.id} value={cam.id}>
                          {cam.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex items-center gap-2 ml-auto">
                  {scanning ? (
                    <button onClick={pause} className="btn-ghost text-xs py-1 px-2.5 text-amber-400">
                      <CameraOff className="h-3.5 w-3.5" /> Pause Feed
                    </button>
                  ) : (
                    <button onClick={resume} className="btn-secondary text-xs py-1 px-2.5">
                      <Camera className="h-3.5 w-3.5" /> Start Camera
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* TAB 2: UPLOAD QR IMAGE FILE */}
            {mode === "file" && (
              <div className="flex flex-col py-1 space-y-3">
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-olive-700/50 hover:border-olive-400/80 rounded-xl p-8 text-center cursor-pointer bg-steel-900/40 hover:bg-steel-900/70 transition-all flex flex-col items-center justify-center space-y-3 min-h-[380px]"
                >
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                  <div className="h-14 w-14 rounded-full bg-tactical-surface border border-olive-500/40 flex items-center justify-center text-olive-300 shadow-inner">
                    <UploadCloud className="h-7 w-7" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-olive-100">Click to upload or drag & drop QR image</p>
                    <p className="text-xs text-steel-400 mt-1">Supports PNG, JPG, and WEBP photos of firearm QR labels</p>
                  </div>
                  <button type="button" className="btn-secondary text-xs mt-2">
                    Browse Image
                  </button>
                </div>

                <div className="p-2.5 rounded-lg bg-steel-950/60 border border-olive-700/25 text-xs text-steel-400 flex items-center gap-2.5">
                  <ShieldCheck className="h-4 w-4 text-olive-400 shrink-0" />
                  <p className="text-[11px] text-steel-400 leading-tight">
                    Browser-integrated image decoding extracts Quick Response payloads directly from photos for armory verification.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: what was scanned or uploaded (5 cols) */}
        {/* Grows to fit the result (never scrolls); the row takes the taller of the two columns. */}
        <div className="lg:col-span-5 min-w-0 flex">
          <section aria-labelledby="scan-result-heading" className="glass flex flex-1 flex-col rounded-xl p-4 sm:p-5">
            <div className="mb-3 flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2">
              <h2 id="scan-result-heading" className="flex items-center gap-2 text-sm font-semibold text-steel-100">
                <ShieldCheck className="h-4 w-4 text-olive-300" /> Scan result
              </h2>
              {hit && (
                <button
                  onClick={() => setHit(null)}
                  className="btn-ghost min-h-10 px-2 text-xs text-steel-300"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Scan another
                </button>
              )}
            </div>

            <AnimatePresence mode="wait">
              {hit ? (
                <motion.div
                  key={hit.equipment_id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-1 flex-col gap-4"
                >
                  <div className="flex-1 space-y-4">
                    {/* 1. Which firearm, and where it stands */}
                    {/* Name on the left; status and serial stacked on the right */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-xl font-semibold leading-tight tracking-tight text-olive-50">{hit.model}</h3>
                        <p className="mt-0.5 text-xs text-steel-400">
                          {[hit.manufacturer, hit.category?.category_name].filter(Boolean).join(" · ") || "Firearm"}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className={cn("pill normal-case tracking-normal", STATUSES[hit.availability_status]?.tone ?? "pill-muted")}>
                          {STATUSES[hit.availability_status]?.label ?? "Unknown"}
                        </span>
                        <button
                          onClick={() => copySerial(hit.serial_number)}
                          className="inline-flex items-center gap-1.5 rounded-md bg-steel-900/70 px-2 py-0.5 transition-colors hover:bg-steel-800"
                          aria-label={copiedSerial ? "Serial number copied" : `Copy serial number ${hit.serial_number}`}
                          title="Copy serial number"
                        >
                          <span className="text-[10px] text-steel-400">SN</span>
                          <span className="font-mono text-xs text-steel-100">{hit.serial_number}</span>
                          {copiedSerial ? <Check className="h-3 w-3 shrink-0 text-emerald-300" /> : <Copy className="h-3 w-3 shrink-0 text-steel-400" />}
                        </button>
                      </div>
                    </div>

                    <ScanNotice firearm={hit} />

                    {/* 2. Who has it */}
                    {isCheckedOut && (
                      <ScanSection
                        title="Custody"
                        aside={activeTx?.expected_return_at && (
                          hit.availability_status === 4
                            ? <span className="font-medium text-red-300">Overdue · {fmtRelative(activeTx.expected_return_at)}</span>
                            : <span className="text-steel-400">Due {fmtRelative(activeTx.expected_return_at)}</span>
                        )}
                      >
                        <ScanRow label="Issued to">{holderName(activeTx) ?? "Not recorded"}</ScanRow>
                        {activeTx?.checkout_at && <ScanRow label="Issued on">{fmtDate(activeTx.checkout_at, LONG_DATE)}</ScanRow>}
                        <ScanRow label="Return due">
                          {activeTx?.expected_return_at ? (
                            <span className={hit.availability_status === 4 ? "text-red-200" : undefined}>
                              {fmtDate(activeTx.expected_return_at, LONG_DATE)}
                            </span>
                          ) : "Not recorded"}
                        </ScanRow>
                      </ScanSection>
                    )}

                    {/* 3. The firearm itself */}
                    <ScanSection title="Details">
                      <ScanRow label="Condition">
                        <span className="inline-flex items-center gap-2">
                          <span className={cn("h-2 w-2 rounded-full", CONDITION_DOT[hit.condition_status] ?? "bg-steel-500")} aria-hidden />
                          {CONDITIONS[hit.condition_status]?.label ?? "Unknown"}
                        </span>
                      </ScanRow>
                      <ScanRow label="Caliber">{hit.caliber || "—"}</ScanRow>
                      <ScanRow label="Kept at">{hit.current_location?.location_name ?? "—"}</ScanRow>
                    </ScanSection>
                  </div>

                  {/* What to do next */}
                  <div className="shrink-0 space-y-2">
                    {canRelease && hit.availability_status !== 3 && (
                      <button
                        onClick={() => router.push(isCheckedOut
                          // A checked-out firearm is returned from its open issuance in the ledger.
                          ? `/transactions?equipment_id=${hit.equipment_id}`
                          : `/transactions/new?equipment_id=${hit.equipment_id}`)}
                        className="btn-primary min-h-10 w-full text-sm"
                      >
                        <span>{isCheckedOut ? "Process Return" : "Issue Firearm"}</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => router.push(`/firearms/${hit.equipment_id}`)}
                        className="btn-secondary min-h-10 px-2 text-xs"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span>Full Record</span>
                      </button>
                      <button
                        onClick={() => router.push(`/maintenance?equipment_id=${hit.equipment_id}`)}
                        className="btn-secondary min-h-10 px-2 text-xs"
                      >
                        <Wrench className="h-3.5 w-3.5" />
                        <span>Maintenance</span>
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center p-4 text-center space-y-3 lg:min-h-0">
                  <div className="h-14 w-14 rounded-full bg-steel-900 border border-olive-700/40 flex items-center justify-center text-olive-400/70">
                    <QrCode className="h-7 w-7" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-olive-100">No firearm scanned yet</h3>
                    <p className="text-xs leading-relaxed text-steel-300 mt-1 max-w-xs">
                      Point the camera at a firearm&apos;s QR label, or upload a photo of it. Its details and what to do next show here.
                    </p>
                  </div>
                </div>
              )}
            </AnimatePresence>
          </section>
        </div>
      </div>


      {/* RECENT SCANS HISTORY TABLE */}
      {recentScans.length > 0 && (
        <div className="glass rounded-xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <History className="h-4 w-4 text-olive-300" />
              <h3 className="text-sm font-bold text-olive-100">Recent Scans (Current Session)</h3>
              <span className="pill pill-tactical text-[10px]">{recentScans.length} logged</span>
            </div>
            <button onClick={() => setRecentScans([])} className="btn-ghost text-xs py-1 px-2 ml-auto text-steel-400 hover:text-red-400">
              Clear History
            </button>
          </div>

          {/* Phone layout: one card per scan instead of a five-column table */}
          <ul className="sm:hidden space-y-2">
            {recentScans.map((scan) => (
              <li
                key={`${scan.equipment_id}-${scan.timestamp}-card`}
                className="rounded-lg border border-olive-700/30 bg-steel-900/50 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs font-semibold text-olive-100 truncate">{scan.serial_number}</p>
                  <p className="text-xs text-steel-300 truncate">{scan.model}</p>
                  <p className="text-[10px] font-mono text-steel-500 mt-0.5">{scan.timestamp}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className={`pill ${STATUSES[scan.availability_status]?.tone}`}>
                    {STATUSES[scan.availability_status]?.label}
                  </span>
                  <button
                    onClick={() => {
                      setHit(scan.data);
                      toast.info(`Loaded ${scan.serial_number}`);
                    }}
                    className="btn-ghost text-xs py-1 px-2 text-olive-300 hover:text-olive-100"
                  >
                    Inspect
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden sm:block overflow-x-auto">
            <table className="table-auto w-full text-xs">
              <thead>
                <tr className="border-b border-olive-700/30 text-[10px] uppercase tracking-wider text-olive-300 text-left">
                  <th className="py-2 px-3">Time</th>
                  <th className="py-2 px-3">Serial Number</th>
                  <th className="py-2 px-3">Model</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-olive-700/20">
                {recentScans.map((scan) => (
                  <tr key={`${scan.equipment_id}-${scan.timestamp}`} className="hover:bg-steel-850/50 transition-colors">
                    <td className="py-2.5 px-3 font-mono text-steel-400">{scan.timestamp}</td>
                    <td className="py-2.5 px-3 font-mono font-semibold text-olive-100">{scan.serial_number}</td>
                    <td className="py-2.5 px-3 text-steel-300">{scan.model}</td>
                    <td className="py-2.5 px-3">
                      <span className={`pill ${STATUSES[scan.availability_status]?.tone}`}>{STATUSES[scan.availability_status]?.label}</span>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        onClick={() => {
                          setHit(scan.data);
                          toast.info(`Loaded ${scan.serial_number}`);
                        }}
                        className="btn-ghost text-xs py-1 px-2 text-olive-300 hover:text-olive-100"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  </>
  );
}

/** "Sep 19, 2026 at 3:08 AM" */
const LONG_DATE = "MMM d, yyyy 'at' h:mm a";

/** Condition shown as a coloured dot beside its name (quieter than a second badge). */
const CONDITION_DOT: Record<number, string> = {
  1: "bg-emerald-400",
  2: "bg-olive-400",
  3: "bg-amber-400",
  4: "bg-red-400",
};

function holderName(tx: ActiveTransaction | null) {
  if (!tx?.user) return null;
  return `${tx.user.rank ? `${tx.user.rank} ` : ""}${tx.user.first_name} ${tx.user.last_name}`;
}

/** Why it can't be issued, when it is under maintenance (an overdue return shows in red under Custody). */
function ScanNotice({ firearm }: { firearm: FirearmLookupResult }) {
  if (firearm.availability_status === 3) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
        <Wrench className="mt-px h-4 w-4 shrink-0 text-amber-300" />
        <span>Under maintenance. It can&apos;t be issued until it is back in the armory.</span>
      </p>
    );
  }
  return null;
}

/** A titled group of label and value rows on a quiet panel. */
function ScanSection({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className="text-xs font-semibold text-steel-300">{title}</h4>
        {aside && <span className="text-right text-[11px]">{aside}</span>}
      </div>
      <dl className="space-y-2 rounded-lg bg-steel-900/50 px-3 py-2.5">{children}</dl>
    </section>
  );
}

function ScanRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-xs text-steel-400">{label}</dt>
      <dd className="break-words text-sm text-steel-100">{children}</dd>
    </div>
  );
}
