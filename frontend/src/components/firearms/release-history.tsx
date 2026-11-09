"use client";

import { ArrowDownLeft, ArrowUpRight, Hammer, PackageCheck, Wrench, AlertTriangle } from "lucide-react";
import { fmtDate, fmtPeso, MAINTENANCE_RESULTS, PURPOSES } from "@/lib/utils";
import { personName, REPAIR_STATUSES, RepairTimeline, type Repair } from "@/components/maintenance/repair-requests";

type Event = { at: string; kind: string; detail: string; Icon: any; tone: string };

/**
 * Everything that took the firearm out of the armory or brought it back: issued for use and
 * returned, sent for repair and released from maintenance, plus routine maintenance. It answers
 * who used the firearm and who maintained it (defense feedback, 2026-11).
 */
export function ReleaseHistory({ firearm }: { firearm: any }) {
  const repairs: Repair[] = firearm.repairs ?? [];
  const events: Event[] = [];

  for (const t of firearm.transactions ?? []) {
    events.push({
      at: t.checkout_at, kind: "Released for use", Icon: ArrowUpRight, tone: "text-blue-300",
      detail: `Issued to ${personName(t.user)} by ${personName(t.authorizer)} · ${PURPOSES[t.purpose] ?? "Deployment"}`,
    });
    if (t.actual_return_at) {
      events.push({
        at: t.actual_return_at, kind: "Returned to the armory", Icon: ArrowDownLeft, tone: "text-emerald-300",
        detail: `From ${personName(t.user)}`,
      });
    }
  }
  for (const r of repairs) {
    events.push({
      at: r.reported_at, kind: "Reported for repair", Icon: AlertTriangle, tone: "text-amber-300",
      detail: `${r.problem} · by ${personName(r.reporter)}`,
    });
    if (r.sent_at) {
      events.push({
        at: r.sent_at, kind: "Sent for repair", Icon: Hammer, tone: "text-amber-300",
        detail: `Received by ${r.received_by}${r.received_by_unit ? ` (${r.received_by_unit})` : ""} · released by ${personName(r.sender)}`,
      });
    }
    if (r.returned_at) {
      events.push({
        at: r.returned_at, kind: "Released from maintenance", Icon: PackageCheck, tone: "text-emerald-300",
        detail: `Repaired by ${r.received_by} on ${fmtDate(r.repaired_at, "yyyy-MM-dd")} · ${MAINTENANCE_RESULTS[r.result_status ?? 0]?.label ?? ""}`
          + `${r.cost ? ` · ${fmtPeso(r.cost)}` : ""} · received by ${personName(r.return_receiver)}`,
      });
    }
  }
  // Routine work done in the armory (repairs are already listed above).
  for (const m of firearm.maintenance_records ?? []) {
    if (m.maintenance_type === "Repair" && m.repaired_by) continue;
    events.push({
      at: m.maintenance_date, kind: `Maintenance: ${m.maintenance_type}`, Icon: Wrench, tone: "text-olive-300",
      detail: `${m.description} · by ${m.repaired_by ?? personName(m.technician)} · ${MAINTENANCE_RESULTS[m.result_status]?.label ?? ""}`,
    });
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="glass rounded-xl p-6 space-y-4 print:hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-steel-800 pb-3">
        <div>
          <h2 className="text-base font-bold text-olive-50 flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-olive-400" /> Release History
          </h2>
          <p className="text-xs text-steel-400">Who used it, who maintained it, and every release from use or from maintenance</p>
        </div>
        <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-steel-900 border border-steel-700/60 text-olive-300 self-start sm:self-auto">
          {events.length} Events
        </span>
      </div>

      {repairs.filter((r) => !["completed", "rejected"].includes(r.status)).map((r) => (
        <div key={r.repair_id} className="rounded-lg border border-amber-600/30 bg-amber-900/10 p-3 space-y-2">
          <p className="text-xs text-amber-200 flex flex-wrap items-center gap-2">
            <Hammer className="h-3.5 w-3.5" /> Repair in progress (request #{r.repair_id})
            <span className={`pill text-[10px] ${REPAIR_STATUSES[r.status]?.tone}`}>{REPAIR_STATUSES[r.status]?.label}</span>
          </p>
          <RepairTimeline repair={r} />
        </div>
      ))}

      {events.length === 0 ? (
        <p className="text-steel-500 py-6 text-center text-xs">No releases or maintenance recorded for this firearm yet.</p>
      ) : (
        <ol className="relative border-l border-steel-800 ml-2 space-y-3">
          {events.map((e, i) => (
            <li key={i} className="ml-4">
              <span className="absolute -left-[9px] mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-steel-900 border border-steel-700">
                <e.Icon className={`h-2.5 w-2.5 ${e.tone}`} />
              </span>
              <p className="text-xs">
                <span className={`font-semibold ${e.tone}`}>{e.kind}</span>
                <span className="text-steel-500 font-mono ml-2">{fmtDate(e.at)}</span>
              </p>
              <p className="text-xs text-steel-300 break-words">{e.detail}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
