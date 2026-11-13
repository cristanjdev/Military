import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, PlugZap, type LucideIcon } from "lucide-react";
import { cn, fmtRelative } from "@/lib/utils";

/* The system alerts at 20% (Low Battery) and 10% (Battery Critical); the levels follow those alerts. */
interface Level {
  label: string;
  Icon: LucideIcon;
  text: string;
  bar: string;
}

/* "absent": the tracker measures no cell (USB power with the battery switched off, no cell, or a
 * loose divider wire). That is not an empty battery, so it gets its own neutral state. */
export function batteryLevel(pct: number | null | undefined, absent = false): Level {
  if (absent) return { label: "No battery", Icon: PlugZap, text: "text-sky-400", bar: "bg-steel-700" };
  if (pct == null) return { label: "Not reported", Icon: Battery, text: "text-steel-500", bar: "bg-steel-700" };
  if (pct <= 10) return { label: "Critical", Icon: BatteryWarning, text: "text-red-400", bar: "bg-red-500" };
  if (pct <= 20) return { label: "Low", Icon: BatteryLow, text: "text-amber-400", bar: "bg-amber-500" };
  if (pct <= 50) return { label: "Fair", Icon: BatteryMedium, text: "text-olive-300", bar: "bg-olive-500" };
  return { label: "Good", Icon: BatteryFull, text: "text-emerald-400", bar: "bg-emerald-500" };
}

const volts = (mv: number | null | undefined) => (mv == null ? null : `${(mv / 1000).toFixed(2)} V`);

/** Icon and percentage for a collapsed list row. */
export function BatteryBadge({ pct, absent = false }: { pct: number | null | undefined; absent?: boolean }) {
  const level = batteryLevel(pct, absent);
  const title = absent
    ? "No battery measured: USB power or the battery is switched off"
    : pct == null ? "No battery reading from this tracker" : `Battery ${pct}% · ${level.label}`;
  return (
    <div className="flex items-center gap-1" title={title}>
      <level.Icon className={cn("h-3.5 w-3.5", pct == null && !absent ? "text-steel-600" : level.text)} />
      <span className={cn("font-mono text-[10px] font-semibold", level.text)}>{absent ? "USB" : pct == null ? "—" : `${pct}%`}</span>
    </div>
  );
}

/**
 * The wide map card's battery: everything on one row (level, then a short explanation, voltage and
 * age). On a narrow card the explanation ends in "…" and the full wording shows on hover.
 */
export function BatterySummary({
  pct,
  mv,
  absent = false,
  reportedAt,
}: {
  pct: number | null | undefined;
  mv?: number | null;
  absent?: boolean;
  reportedAt?: string | null;
}) {
  const level = batteryLevel(pct, absent);
  const ago = reportedAt ? fmtRelative(reportedAt) : null;
  const short = absent
    ? ["USB power or battery off", volts(mv), ago]
    : pct == null
    ? ["Tracker has not sent a level"]
    : [volts(mv), ago];
  const full = absent
    ? ["USB power, or the battery is off or not connected", volts(mv), ago && `reported ${ago}`]
    : pct == null
    ? ["The tracker has not sent a battery level"]
    : [volts(mv), ago && `reported ${ago}`];
  return (
    <div className="flex items-center gap-2 min-w-0 whitespace-nowrap" title={`${level.label} · ${full.filter(Boolean).join(" · ")}`}>
      <level.Icon className={cn("h-3.5 w-3.5 shrink-0", level.text)} />
      {!absent && pct != null && (
        <div className="w-16 h-1.5 shrink-0 bg-steel-800 rounded-full overflow-hidden border border-steel-700/60">
          <div className={cn("h-full rounded-full transition-all", level.bar)} style={{ width: `${Math.max(4, Math.min(100, pct))}%` }} />
        </div>
      )}
      <span className={cn("shrink-0 text-[12px] font-semibold", level.text)}>
        {!absent && pct != null ? `${pct}% · ${level.label}` : level.label}
      </span>
      <span className="min-w-0 truncate text-[10px] text-steel-500">· {short.filter(Boolean).join(" · ")}</span>
    </div>
  );
}

/** Bar, percentage, level, voltage and the time of the reading, for the details panel. */
export function BatteryDetails({
  pct,
  mv,
  absent = false,
  reportedAt,
  label = "Battery",
}: {
  pct: number | null | undefined;
  mv?: number | null;
  absent?: boolean;
  reportedAt?: string | null;
  label?: string;
}) {
  const level = batteryLevel(pct, absent);
  const reported = reportedAt ? ` · reported ${fmtRelative(reportedAt)}` : "";
  return (
    <div className="flex justify-between items-start gap-3">
      <span className="text-steel-400">{label}</span>
      {absent ? (
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <level.Icon className={cn("h-3.5 w-3.5", level.text)} />
            <span className={cn("text-[11px] font-semibold", level.text)}>{level.label}</span>
          </div>
          <span className="block text-[10px] text-steel-500 mt-0.5">
            USB power, or the battery is off or not connected{mv != null ? ` (${volts(mv)})` : ""}{reported}
          </span>
        </div>
      ) : pct == null ? (
        <div className="text-right">
          <span className="text-[10px] text-steel-500">Not reported</span>
          <span className="block text-[10px] text-steel-600">The tracker has not sent a battery level</span>
        </div>
      ) : (
        <div className="text-right">
          <div className="flex items-center justify-end gap-2">
            <level.Icon className={cn("h-3.5 w-3.5", level.text)} />
            <div className="w-16 h-1.5 bg-steel-800 rounded-full overflow-hidden border border-steel-700/60">
              <div className={cn("h-full rounded-full transition-all", level.bar)} style={{ width: `${Math.max(4, Math.min(100, pct))}%` }} />
            </div>
            <span className={cn("font-mono text-[11px] font-semibold min-w-[32px] text-right", level.text)}>{pct}%</span>
          </div>
          <span className="block text-[10px] text-steel-500 mt-0.5">
            <span className={level.text}>{level.label}</span>
            {mv != null ? ` · ${volts(mv)}` : ""}
            {reported}
          </span>
        </div>
      )}
    </div>
  );
}
