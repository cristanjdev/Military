"use client";

import { useRef, useState, useCallback } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera,
  CameraOff,
  QrCode,
  CheckCircle,
  XCircle,
  RotateCcw,
  ClipboardCheck,
  Volume2,
  VolumeX,
  RefreshCw,
  SlidersHorizontal,
  Download,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useQrCamera, type ScanFeedback } from "@/lib/use-qr-camera";
import { ScanDetectionOverlay } from "@/components/scan/scan-detection-overlay";
import { CONDITIONS, STATUSES, cn } from "@/lib/utils";

interface ScannedItem {
  equipment_id: number;
  serial_number: string;
  model: string;
  condition_status: number;
  availability_status: number;
  found: boolean;
  scanned_at: string;
}

export default function InventoryValidationPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // Inventory validation items
  const [scannedItems, setScannedItems] = useState<ScannedItem[]>([]);
  const [notFound, setNotFound] = useState<string[]>([]);

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

  // Process firearm lookup
  const processLookup = useCallback(
    async (decoded: string): Promise<ScanFeedback | undefined> => {
      const trimmed = decoded.trim();
      if (!trimmed) return;

      // Extract serial if JSON payload
      let serialCandidate = trimmed;
      try {
        const payload = JSON.parse(trimmed);
        serialCandidate = payload.serial_number || payload.qr_code || trimmed;
      } catch {}

      // Avoid processing duplicates
      const alreadyCounted = scannedItems.find((i) => i.serial_number === serialCandidate);
      if (alreadyCounted) {
        return { status: "duplicate", label: `${alreadyCounted.serial_number} · ${alreadyCounted.model}` };
      }

      try {
        const { data } = await api.post("/firearms/lookup", { qr_payload: trimmed });
        if (scannedItems.some((i) => i.equipment_id === data.equipment_id)) {
          return { status: "duplicate", label: `${data.serial_number} · ${data.model}` };
        }
        setScannedItems((prev) => {
          if (prev.some((i) => i.equipment_id === data.equipment_id)) return prev;
          playBeep();
          toast.success(`Verified: ${data.serial_number} (${data.model})`);
          return [
            {
              equipment_id: data.equipment_id,
              serial_number: data.serial_number,
              model: data.model,
              condition_status: data.condition_status,
              availability_status: data.availability_status,
              found: true,
              scanned_at: new Date().toLocaleTimeString(),
            },
            ...prev,
          ];
        });
        return { status: "success", label: `${data.serial_number} · ${data.model}` };
      } catch {
        setNotFound((prev) => {
          if (prev.includes(trimmed)) return prev;
          toast.error("Firearm not registered in database.");
          return [trimmed, ...prev];
        });
        return { status: "error", label: "Not registered in the armory database" };
      }
    },
    [scannedItems, playBeep]
  );

  // Live camera: start/stop is serialized inside the hook so pausing, switching cameras and
  // leaving the page can never strand a running webcam stream.
  const { scanning, detection, cameraError, cameras: availableCameras, selectedCameraId, selectCamera, pause, resume, retry } =
    useQrCamera({ viewportId: "inventory-qr-viewport", onDecode: processLookup, rearmMs: 1500 });

  function resetSession() {
    setScannedItems([]);
    setNotFound([]);
    toast.info("Batch inventory session cleared.");
  }

  // Export audit summary as CSV
  function exportAuditCsv() {
    if (scannedItems.length === 0 && notFound.length === 0) {
      toast.error("No inventory data to export.");
      return;
    }
    const headers = ["Serial Number", "Model", "Condition", "Status", "Validation Result", "Scanned At"];
    const rows = [
      ...scannedItems.map((item) => [
        item.serial_number,
        `"${item.model}"`,
        CONDITIONS[item.condition_status]?.label || "N/A",
        STATUSES[item.availability_status]?.label || "N/A",
        "VERIFIED",
        item.scanned_at,
      ]),
      ...notFound.map((item) => [
        `"${item}"`,
        "Unknown",
        "N/A",
        "N/A",
        "UNREGISTERED / NOT FOUND",
        new Date().toLocaleTimeString(),
      ]),
    ];
    const csvContent =
      "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `armory_inventory_audit_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Inventory audit exported to CSV");
  }

  const totalScanned = scannedItems.length + notFound.length;
  const matchRate = totalScanned > 0 ? Math.round((scannedItems.length / totalScanned) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-wide text-olive-50">Batch Inventory QR Validation</h1>
            <span className="pill pill-tactical text-[11px] font-mono flex items-center gap-1 whitespace-nowrap shrink-0">
              <ClipboardCheck className="h-3 w-3" /> BATCH-VAL 1.0
            </span>
          </div>
          <p className="text-xs text-steel-400 mt-0.5">
            Continuous optical QR scanning to rapidly audit and validate physical armory stock against the database.
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

          {/* Single Scan Navigation */}
          <Link href="/scan" className="btn-secondary text-xs px-3 py-2 sm:py-1.5 flex items-center justify-center gap-1.5">
            <QrCode className="h-3.5 w-3.5 text-tactical-accent" />
            <span>Single QR Scan</span>
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-12 gap-5 items-stretch">
        {/* LEFT COLUMN: SCANNER VIEWPORT (7 cols) */}
        <div className="lg:col-span-7 flex flex-col">
          <div className="glass rounded-xl p-4 sm:p-5 flex-1 flex flex-col">
            {/* Header */}
            <div className="mb-3 flex min-h-10 items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-steel-100">
                <Camera className="h-4 w-4 text-olive-300" /> Camera
              </h2>
              {scanning && (
                <span className="pill pill-tactical normal-case tracking-normal text-[11px] flex items-center gap-1.5 whitespace-nowrap">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Scanning
                </span>
              )}
            </div>

            {/* LIVE CAMERA VIEWPORT */}
            <div className="flex-1 flex flex-col justify-between space-y-3">
              <div className="relative aspect-[4/3] w-full max-h-[420px] mx-auto overflow-hidden rounded-lg bg-black border border-olive-700/50 shadow-inner flex items-center justify-center">
                {/* HTML5 QR Code Mount Target */}
                <div id="inventory-qr-viewport" ref={containerRef} className="absolute inset-0 w-full h-full" />
                <ScanDetectionOverlay detection={detection} />

                {/* Viewfinder & Animated Laser Overlay */}
                {scanning && !cameraError && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 overflow-hidden">
                    <div className="relative w-full h-full max-w-xs max-h-64 sm:max-h-72 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] border border-yellow-500/40">
                      {/* Tactical Reticle Corners */}
                      <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-yellow-400 rounded-tl-lg z-20" />
                      <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-yellow-400 rounded-tr-lg z-20" />
                      <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-yellow-400 rounded-bl-lg z-20" />
                      <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-yellow-400 rounded-br-lg z-20" />

                      {/* Sweeping Laser Beam with Glowing Aura */}
                      <div className="absolute left-0 right-0 h-1 bg-gradient-to-r from-yellow-400 via-white to-yellow-400 animate-laser z-10 shadow-[0_0_18px_4px_rgba(250,204,21,1)]">
                        <div className="absolute left-0 right-0 -top-8 h-8 bg-gradient-to-b from-transparent to-yellow-400/25 pointer-events-none" />
                        <div className="absolute left-0 right-0 top-1 h-8 bg-gradient-to-t from-transparent to-yellow-400/25 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Camera Error Overlay */}
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
                    </div>
                  </div>
                )}
              </div>

              {/* Hardware Controls */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs mt-auto">
                {availableCameras.length > 1 && (
                  <div className="flex items-center gap-1.5">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-steel-400" />
                    <select
                      value={selectedCameraId}
                      onChange={(e) => selectCamera(e.target.value)}
                      className="bg-steel-800 border border-olive-700/40 rounded px-2 py-1 text-xs text-olive-100"
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
          </div>
        </div>

        {/* RIGHT COLUMN: what this batch has found so far (5 cols) */}
        <div className="lg:col-span-5 flex flex-col">
          <section aria-labelledby="batch-results-heading" className="glass rounded-xl p-4 sm:p-5 flex-1 flex flex-col">
            <div className="mb-3 flex min-h-10 items-center justify-between gap-2">
              <h2 id="batch-results-heading" className="flex items-center gap-2 text-sm font-semibold text-steel-100">
                <ClipboardCheck className="h-4 w-4 text-olive-300" /> Batch results
              </h2>
              {totalScanned > 0 && (
                <span className="text-xs text-steel-400">{totalScanned} scanned</span>
              )}
            </div>

            {/* Running totals */}
            <div className="grid grid-cols-3 gap-2">
              <BatchStat label="Verified" value={scannedItems.length} tone="text-emerald-300" />
              <BatchStat label="Not registered" value={notFound.length} tone={notFound.length > 0 ? "text-red-300" : "text-steel-300"} />
              <BatchStat label="Match rate" value={totalScanned > 0 ? `${matchRate}%` : "—"} tone="text-olive-100" />
            </div>

            <div className="flex-1 py-4">
              {totalScanned === 0 ? (
                <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center space-y-3 px-4">
                  <div className="h-14 w-14 rounded-full bg-steel-900 border border-olive-700/40 flex items-center justify-center text-olive-400/70">
                    <QrCode className="h-7 w-7" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-olive-100">No firearms scanned yet</h3>
                    <p className="text-xs leading-relaxed text-steel-300 mt-1 max-w-xs">
                      Hold each firearm&apos;s QR label up to the camera, one after another. Each one is checked against the
                      armory records and listed here.
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence initial={false}>
                    {notFound.map((tag) => (
                      <motion.li
                        key={`not-found-${tag}`}
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-center gap-3 rounded-lg bg-red-500/10 px-3 py-2.5"
                      >
                        <XCircle className="h-4 w-4 shrink-0 text-red-300" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-red-200">Not in the armory records</p>
                          <p className="truncate font-mono text-[11px] text-steel-400" title={tag}>{tag}</p>
                        </div>
                      </motion.li>
                    ))}

                    {scannedItems.map((item) => (
                      <motion.li
                        key={item.equipment_id}
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-center gap-3 rounded-lg bg-steel-900/50 px-3 py-2.5"
                      >
                        <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate">
                            <span className="font-mono text-sm text-steel-100">{item.serial_number}</span>
                            <span className="ml-2 text-xs text-steel-400">{item.model}</span>
                          </p>
                          <p className="text-[11px] text-steel-500">Scanned {item.scanned_at}</p>
                        </div>
                        <span className={cn("pill shrink-0 normal-case tracking-normal", STATUSES[item.availability_status]?.tone ?? "pill-muted")}>
                          {STATUSES[item.availability_status]?.label ?? "Unknown"}
                        </span>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={exportAuditCsv}
                disabled={totalScanned === 0}
                className="btn-primary min-h-10 text-xs"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export CSV</span>
              </button>
              <button
                onClick={resetSession}
                disabled={totalScanned === 0}
                className="btn-secondary min-h-10 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Clear batch</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function BatchStat({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="rounded-lg bg-steel-900/50 px-3 py-2.5 text-center">
      <p className={cn("text-lg font-semibold leading-none", tone)}>{value}</p>
      <p className="mt-1.5 truncate text-[11px] text-steel-400">{label}</p>
    </div>
  );
}
