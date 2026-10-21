"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AxiosError } from "axios";
import { Check, Fingerprint, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { BiometricCancelled, PendingConfirmation, useBiometricConfirm } from "@/store/biometric-confirm";
import {
  BRIDGE_NOT_RUNNING,
  captureFingerprintTemplate,
  probeBridgeDetail,
  useBridgeProgress,
  type BridgeMode,
} from "@/lib/biometric-bridge";

// How long the "accepted" tick shows before the action continues.
const SUCCESS_DELAY_MS = 1200;
// After a rejected scan the retry button waits briefly, so a wrong finger cannot be retried instantly.
const FAILURE_COOLDOWN_SECONDS = 3;

const ACTION_TEXT = {
  issue: { title: "Confirm issuance", detail: "Scan your fingerprint to issue this firearm." },
  return: { title: "Confirm return", detail: "Scan your fingerprint to record this return." },
} as const;

/** Mounted once in the signed-in layout; shows the scan popup whenever confirmBiometric() is awaiting. */
export function BiometricConfirmHost() {
  const pending = useBiometricConfirm((s) => s.pending);
  if (!pending || typeof document === "undefined") return null;

  // key: a fresh challenge always starts a fresh dialog.
  return createPortal(<ConfirmDialog key={pending.challenge} pending={pending} />, document.body);
}

type Phase = "starting" | "scanning" | "success" | "failed";

function ConfirmDialog({ pending }: { pending: PendingConfirmation }) {
  const close = useBiometricConfirm((s) => s.close);
  const [phase, setPhase] = useState<Phase>("starting");
  const [mode, setMode] = useState<BridgeMode>("checking");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const finishedRef = useRef(false);

  const progress = useBridgeProgress(phase === "scanning" && mode === "bridge");
  const text = ACTION_TEXT[pending.action];

  const cancel = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    pending.reject(new BiometricCancelled());
    close();
  }, [pending, close]);

  const scan = useCallback(async (scanMode: "bridge" | "demo") => {
    setError(null);
    setPhase("scanning");
    try {
      const capture = await captureFingerprintTemplate(pending.username, pending.challenge, scanMode, false);
      const { data } = await api.post<{ grant: string }>("/auth/biometric/step-up/verify", {
        challenge: pending.challenge,
        fingerprint: capture.template,
        source: capture.source,
        capture_signature: capture.captureSignature,
        captured_at: capture.capturedAt,
      });

      setPhase("success");
      await new Promise((resolve) => setTimeout(resolve, SUCCESS_DELAY_MS));
      if (finishedRef.current) return;
      finishedRef.current = true;
      pending.resolve(data.grant);
      close();
    } catch (err: unknown) {
      if (finishedRef.current) return;
      if (err instanceof AxiosError && err.response?.status === 419) setExpired(true);
      setError(
        err instanceof AxiosError
          ? err.response?.data?.message ?? "Fingerprint confirmation failed."
          : err instanceof Error
            ? err.message
            : "Fingerprint confirmation failed."
      );
      setPhase("failed");
      setCooldown(FAILURE_COOLDOWN_SECONDS);
    }
  }, [pending, close]);

  // Start scanning as soon as the popup opens, if the scanner program is reachable.
  useEffect(() => {
    let alive = true;
    probeBridgeDetail().then(({ mode: result, message }) => {
      if (!alive) return;
      setMode(result);
      if (result === "unavailable") {
        setError(message ?? BRIDGE_NOT_RUNNING);
        setPhase("failed");
        return;
      }
      void scan(result);
    });
    return () => { alive = false; };
  }, [scan]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && phase !== "success") cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, phase]);

  function retry() {
    setPhase("starting");
    probeBridgeDetail().then(({ mode: result, message }) => {
      setMode(result);
      if (result === "unavailable") {
        setError(message ?? BRIDGE_NOT_RUNNING);
        setPhase("failed");
        setCooldown(FAILURE_COOLDOWN_SECONDS);
      } else {
        void scan(result);
      }
    });
  }

  const phaseNow = progress?.phase;
  const liveMessage = progress?.message ?? "Place your finger on the reader";
  const tone = phaseNow === "poor"
    ? "text-amber-300"
    : phaseNow === "good" || phaseNow === "done"
      ? "text-emerald-300"
      : phaseNow === "finger_on"
        ? "text-olive-100"
        : "text-steel-300";
  const succeeded = phase === "success";

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
      <div
        className="glass w-full max-w-sm rounded-2xl p-6 text-center"
        role="dialog"
        aria-modal="true"
        aria-label={text.title}
      >
        <div className="flex items-start justify-between">
          <div className="text-left">
            <h3 className="text-lg font-bold text-olive-50">{text.title}</h3>
            <p className="mt-0.5 text-xs text-steel-400">{text.detail}</p>
          </div>
          {!succeeded && (
            <button onClick={cancel} className="btn-ghost p-1.5" aria-label="Cancel">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className={`relative mx-auto mt-5 flex h-32 w-32 items-center justify-center overflow-hidden rounded-full border-4 transition-colors ${
          succeeded ? "border-emerald-400/70" : phase === "failed" ? "border-red-500/50" : "border-olive-600/40"
        }`}>
          {succeeded
            ? <Check className="h-16 w-16 text-emerald-300" />
            : <Fingerprint className={`h-20 w-20 transition-colors ${phase === "failed" ? "text-red-300" : phaseNow === "poor" ? "text-amber-300" : phaseNow === "good" ? "text-emerald-300" : "text-olive-300"}`} />}
          {phase === "scanning" && (
            <div className="absolute left-0 right-0 h-1 animate-scan-line bg-olive-300/70 shadow-[0_0_18px_4px_rgba(174,183,113,0.6)]" />
          )}
        </div>

        <div className="mt-4 min-h-[3rem]" aria-live="polite">
          {phase === "starting" && (
            <p className="flex items-center justify-center gap-2 text-sm text-steel-300">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking the scanner...
            </p>
          )}
          {phase === "scanning" && <p className={`text-sm font-medium ${tone}`}>{liveMessage}</p>}
          {succeeded && (
            <>
              <p className="text-base font-semibold text-emerald-300">Fingerprint verified</p>
              <p className="mt-0.5 text-xs text-emerald-100/80">Continuing...</p>
            </>
          )}
          {phase === "failed" && (
            <p className="rounded-md border border-red-700/40 bg-red-900/20 px-3 py-2 text-sm text-red-200" role="alert">
              {error}
            </p>
          )}
        </div>

        {phase === "failed" && (
          <div className="mt-4 flex gap-2">
            <button onClick={cancel} className="btn-ghost flex-1">Cancel</button>
            {!expired && (
              <button onClick={retry} disabled={cooldown > 0} className="btn-primary flex-1">
                {cooldown > 0 ? `Try again in ${cooldown}s` : "Try again"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
