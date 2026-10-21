"use client";

import { useEffect, useState } from "react";

/**
 * Client for the local biometric bridge (biometric-bridge/), the Windows program that talks to
 * the fingerprint reader. Shared by the login step and the issue/return fingerprint confirmation.
 */

export const BRIDGE_URL = (process.env.NEXT_PUBLIC_BIOMETRIC_BRIDGE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export type BridgeMode = "checking" | "bridge" | "unavailable" | "demo";

export type BiometricCapture = {
  template: string;
  source: "digitalpersona_bridge" | "demo_placeholder";
  captureSignature?: string;
  capturedAt?: string;
};

type BridgeCaptureResponse = {
  template?: unknown;
  fingerprint?: unknown;
  fingerprint_template?: unknown;
  signature?: unknown;
  captured_at?: unknown;
  message?: unknown;
};

/** Live capture state published by the bridge at GET /status. */
export type BridgeProgress = {
  active: boolean;
  mode: "enroll" | "verify" | "idle";
  phase: "idle" | "waiting" | "finger_on" | "good" | "poor" | "processing" | "done" | "failed" | "error";
  touches_done: number;
  touches_needed: number;
  message: string;
  feedback: string | null;
  seq: number;
};

export const BRIDGE_NOT_RUNNING =
  "The fingerprint scanner program is not running on this computer. Start the biometric bridge, then try again.";

export type BridgeProbe = {
  mode: Exclude<BridgeMode, "checking">;
  /** Why the scanner can't be used, when the bridge is running but not ready (no reader, SDK service stopped). */
  message?: string;
};

/** Is the bridge reachable and ready? Falls back to the placeholder only when demo mode is explicitly on. */
export async function probeBridgeDetail(): Promise<BridgeProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(`${BRIDGE_URL}/health`, { cache: "no-store", signal: controller.signal });
    if (resp.ok) return { mode: "bridge" };
    const data = await resp.json().catch(() => ({})) as { message?: unknown };
    return {
      mode: DEMO_MODE ? "demo" : "unavailable",
      message: typeof data.message === "string" ? data.message : undefined,
    };
  } catch {
    return { mode: DEMO_MODE ? "demo" : "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeBridge(): Promise<Exclude<BridgeMode, "checking">> {
  return (await probeBridgeDetail()).mode;
}

/**
 * Asks the bridge for one fingerprint capture. `challenge` is the one-time value the bridge signs
 * its answer against, so the backend can tell the scan belongs to this request.
 */
export async function captureFingerprintTemplate(
  username: string | null,
  challenge: string | null,
  mode: "bridge" | "demo",
  enrolling: boolean
): Promise<BiometricCapture> {
  if (mode === "demo") {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return {
      template: `FUT-${username ?? "demo"}-fingerprint-template-fake-but-deterministic`,
      source: "demo_placeholder",
    };
  }

  const controller = new AbortController();
  // Enrollment needs four touches; keep these above the bridge's own timeouts (90 s / 30 s).
  const timeout = setTimeout(() => controller.abort(), enrolling ? 120_000 : 45_000);
  try {
    const resp = await fetch(`${BRIDGE_URL}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, challenge_token: challenge, mode: enrolling ? "enroll" : "verify" }),
      signal: controller.signal,
    });

    const data = await resp.json().catch(() => ({})) as BridgeCaptureResponse;
    if (!resp.ok) {
      throw new Error(typeof data.message === "string" ? data.message : `Fingerprint scanner returned status ${resp.status}.`);
    }

    const template = data.template ?? data.fingerprint ?? data.fingerprint_template;
    if (typeof template !== "string" || template.length < 32) {
      throw new Error("Fingerprint scanner returned an invalid template.");
    }
    if (typeof data.signature !== "string" || !/^[a-f0-9]{64}$/i.test(data.signature)) {
      throw new Error("Fingerprint scanner returned an invalid attestation signature.");
    }
    if (typeof data.captured_at !== "string" || Number.isNaN(Date.parse(data.captured_at))) {
      throw new Error("Fingerprint scanner returned an invalid capture timestamp.");
    }

    return {
      template,
      source: "digitalpersona_bridge",
      captureSignature: data.signature,
      capturedAt: data.captured_at,
    };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Fingerprint capture timed out. Check the scanner connection.");
    }
    if (error instanceof TypeError) {
      // fetch() rejects with a TypeError when nothing is listening on the bridge port.
      throw new Error("Cannot reach the fingerprint scanner program on this computer. Start the biometric bridge and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** While `active`, mirrors the bridge's touch-by-touch progress (polled about four times a second). */
export function useBridgeProgress(active: boolean): BridgeProgress | null {
  const [progress, setProgress] = useState<BridgeProgress | null>(null);

  useEffect(() => {
    if (!active) return;

    let stopped = false;

    const tick = async () => {
      try {
        const resp = await fetch(`${BRIDGE_URL}/status`, { cache: "no-store" });
        if (!resp.ok || stopped) return;
        const data = (await resp.json()) as BridgeProgress;
        // An inactive snapshot is the previous capture's leftover; wait for this one to begin.
        if (data.active && !stopped) setProgress(data);
      } catch {
        // The bridge is busy or briefly unreachable; keep showing the last known state.
      }
    };

    void tick();
    const id = setInterval(tick, 250);
    return () => {
      stopped = true;
      clearInterval(id);
      setProgress(null); // the next scan starts from a clean slate
    };
  }, [active]);

  return progress;
}
