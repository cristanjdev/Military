import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, type LucideIcon } from "lucide-react";
import { cn, fmtRelative } from "@/lib/utils";

/* The system alerts at 20% (Low Battery) and 10% (Battery Critical); the levels follow those alerts. */
interface Level {
  label: string;
  Icon: LucideIcon;
  text: string;
  bar: string;
}

export function batteryLevel(pct: number | null | undefined): Level {
  if (pct == null) return { label: "Not reported", Icon: Battery, text: "text-steel-500", bar: "bg-steel-700" };
  if (pct <= 10) return { label: "Critical", Icon: BatteryWarning, text: "text-red-400", bar: "bg-red-500" };
  if (pct <= 20) return { label: "Low", Icon: BatteryLow, text: "text-amber-400", bar: "bg-amber-500" };
  if (pct <= 50) return { label: "Fair", Icon: BatteryMedium, text: "text-olive-300", bar: "bg-olive-500" };
  return { label: "Good", Icon: BatteryFull, text: "text-emerald-400", bar: "bg-emerald-500" };
}

/** Icon and percentage for a collapsed list row. */
export function BatteryBadge({ pct }: { pct: number | null | undefined }) {
  const level = batteryLevel(pct);
  return (
    <div className="flex items-center gap-1" title={pct == null ? "No battery reading from this tracker" : `Battery ${pct}% · ${level.label}`}>
      <level.Icon className={cn("h-3.5 w-3.5", pct == null ? "text-steel-600" : level.text)} />
      <span className={cn("font-mono text-[10px] font-semibold", level.text)}>{pct == null ? "—" : `${pct}%`}</span>
    </div>
  );
}

/** Bar, percentage, level and the time of the reading, for the details panel and the map popup. */
export function BatteryDetails({ pct, reportedAt, label = "Battery" }: { pct: number | null | undefined; reportedAt?: string | null; label?: string }) {
  const level = batteryLevel(pct);
  return (
    <div className="flex justify-between items-start gap-3">
      <span className="text-steel-400">{label}</span>
      {pct == null ? (
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
            {reportedAt ? ` · reported ${fmtRelative(reportedAt)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
