import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtDate(d?: string | Date | null, pattern = "yyyy-MM-dd HH:mm") {
  if (!d) return "—";
  try {
    return format(new Date(d), pattern);
  } catch {
    return "—";
  }
}

export function fmtRelative(d?: string | Date | null) {
  if (!d) return "—";
  try {
    return formatDistanceToNow(new Date(d), { addSuffix: true });
  } catch {
    return "—";
  }
}

export const PURPOSES: Record<number, string> = {
  1: "Training",
  2: "Operation",
  3: "Maintenance",
  4: "Inspection",
  5: "Funeral",
};

export const CONDITIONS: Record<number, { label: string; tone: string }> = {
  1: { label: "Excellent", tone: "pill-ok" },
  2: { label: "Good",      tone: "pill-tactical" },
  3: { label: "Fair",      tone: "pill-warn" },
  4: { label: "Poor",      tone: "pill-critical" },
};

export const STATUSES: Record<number, { label: string; tone: string }> = {
  1: { label: "Available",   tone: "pill-ok" },
  2: { label: "Checked Out", tone: "pill-info" },
  3: { label: "Maintenance", tone: "pill-warn" },
  4: { label: "Overdue",     tone: "pill-critical" },
};

/** Firearm's fitness after a maintenance job (backend: MaintenanceRecord::RESULT_*). */
export const MAINTENANCE_RESULTS: Record<number, { label: string; tone: string; hint: string }> = {
  1: { label: "Serviceable",          tone: "pill-ok",       hint: "Okay to use. Returns to Available." },
  2: { label: "Needs Further Repair", tone: "pill-warn",     hint: "Not yet okay. Stays in Maintenance." },
  3: { label: "Unserviceable",        tone: "pill-critical", hint: "Cannot be used. Stays in Maintenance." },
};

/**
 * Cleans a typed peso amount down to whole pesos, the way the API stores it.
 * "1,500" -> "1500"; "05" -> "5"; "1500.75" -> "1500" (centavos dropped, never shifted into the
 * pesos: stripping only the dot would turn 15.75 into 1575).
 */
export function wholePesoInput(raw: string): { value: string; droppedCentavos: boolean } {
  const [whole, ...fraction] = raw.replace(/[,\s]/g, "").split(".");
  const digits = whole.replace(/\D/g, "").slice(0, 9);
  return { value: digits === "" ? "" : String(parseInt(digits, 10)), droppedCentavos: fraction.length > 0 };
}

/** Whole pesos, e.g. 2450 -> "PHP 2,450". */
export function fmtPeso(v: number | string | null | undefined): string {
  return `PHP ${Math.round(Number(v) || 0).toLocaleString("en-PH")}`;
}

export const CLEARANCES: Record<number, string> = {
  1: "Confidential",
  2: "Secret",
  3: "Top Secret",
};

/**
 * Pages whose API is guarded by a minimum security clearance (backend: `clearance:N` middleware).
 * Keep in sync with routes/api.php. Pages not listed need no particular clearance.
 */
export const ROUTE_CLEARANCE: Record<string, number> = {
  "/audit": 2,
};

export function requiredClearance(pathname: string): number {
  const match = Object.keys(ROUTE_CLEARANCE)
    .filter((r) => pathname === r || pathname.startsWith(r + "/"))
    .sort((a, b) => b.length - a.length)[0];
  return match ? ROUTE_CLEARANCE[match] : 0;
}
