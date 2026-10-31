"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, LocateFixed, MapPin, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { cn, fmtRelative } from "@/lib/utils";

const LiveMap = dynamic(() => import("@/components/maps/live-map").then((m) => m.LiveMap), { ssr: false });

interface LiveItem {
  equipment_id: number;
  serial_number: string;
  model: string;
  status: string;
  assigned_to?: string | null;
  captured_at?: string | null;
  telemetry_source: "iot" | "stale" | "placeholder" | "missing";
  zones?: string[];
  /** On a trip: in a zone that is neither camp nor destination, or out of camp after the return. */
  needs_attention?: boolean;
  destination?: string | null;
}

interface LiveResponse {
  items: LiveItem[];
  geofences: { location_id: number; location_name: string }[];
}

/**
 * Map of the authorized zones with every firearm that is out, and which zone each one is in.
 * Firearms that need attention are listed first, in red. A firearm on its way to or from its
 * destination is between zones, which is normal.
 */
export function ZoneOccupancy() {
  const [focusId, setFocusId] = useState<number | undefined>(undefined);

  const { data } = useQuery({
    queryKey: ["gps-live"],
    queryFn: async () => (await api.get<LiveResponse>("/gps/live")).data,
    refetchInterval: 30_000,
  });

  const items = data?.items ?? [];
  // A placeholder point is only the assigned zone's centre, so it says nothing about a breach.
  const tracked = items.filter((i) => i.telemetry_source !== "placeholder");
  const attention = tracked.filter((i) => i.needs_attention ?? (i.zones?.length ?? 0) === 0);
  const betweenZones = tracked.filter((i) => (i.zones?.length ?? 0) === 0 && !attention.includes(i));
  const byZone = (data?.geofences ?? []).map((g) => ({
    zone: g.location_name,
    firearms: items.filter((i) => i.zones?.includes(g.location_name)),
  }));

  const row = (i: LiveItem, danger = false) => (
    <li key={i.equipment_id}>
      <button
        type="button"
        onClick={() => setFocusId(i.equipment_id)}
        className={cn(
          "w-full text-left rounded-md border px-2.5 py-1.5 text-xs transition",
          focusId === i.equipment_id ? "border-olive-400/70 bg-olive-800/30" : danger ? "border-red-600/50 bg-red-900/20 hover:bg-red-900/30" : "border-steel-800 bg-steel-900/40 hover:border-olive-600/50"
        )}
      >
        <span className={cn("font-mono font-semibold", danger ? "text-red-200" : "text-olive-100")}>{i.serial_number}</span>
        <span className="text-steel-400"> · {i.model}</span>
        {i.assigned_to && <span className="block text-steel-300">{i.assigned_to}</span>}
        <span className="block text-[10px] text-steel-500">
          {i.telemetry_source === "iot" ? "Live" : i.telemetry_source === "stale" ? "Last known" : "Placeholder"}
          {i.captured_at ? ` · fix ${fmtRelative(i.captured_at)}` : ""}
        </span>
      </button>
    </li>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <div className="glass relative h-[24rem] sm:h-[30rem] overflow-hidden rounded-xl p-2 lg:col-span-8">
        <LiveMap key={focusId ?? "all"} focusId={focusId} />
        {focusId != null && (
          <button
            type="button"
            onClick={() => setFocusId(undefined)}
            className="absolute right-14 top-3 z-[500] rounded-md border border-steel-600/60 bg-steel-900/90 px-2.5 py-1.5 text-[11px] font-semibold text-steel-200 hover:text-olive-200"
          >
            Show all firearms
          </button>
        )}
      </div>

      <div className="glass rounded-xl p-4 lg:col-span-4 max-h-[30rem] overflow-y-auto space-y-4">
        <div>
          <p className={cn("section-title flex items-center gap-2", attention.length ? "text-red-300" : "")}>
            {attention.length ? <AlertTriangle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            Needs attention ({attention.length})
          </p>
          {attention.length === 0 ? (
            <p className="mt-1.5 text-xs text-steel-400">Every tracked firearm is where it should be.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">{attention.map((i) => row(i, true))}</ul>
          )}
        </div>

        {betweenZones.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold text-olive-200 flex items-center gap-1.5">
              <LocateFixed className="h-3.5 w-3.5 text-olive-400" /> On the way, between zones
              <span className="text-steel-500 font-normal">({betweenZones.length})</span>
            </p>
            <ul className="mt-1.5 space-y-1.5">{betweenZones.map((i) => row(i))}</ul>
          </div>
        )}

        {byZone.map(({ zone, firearms }) => (
          <div key={zone}>
            <p className="text-[11px] font-semibold text-olive-200 flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-olive-400" /> {zone}
              <span className="text-steel-500 font-normal">({firearms.length})</span>
            </p>
            {firearms.length > 0 && <ul className="mt-1.5 space-y-1.5">{firearms.map((i) => row(i))}</ul>}
          </div>
        ))}

        {items.length === 0 && (
          <p className="text-xs text-steel-400 flex items-center gap-1.5">
            <LocateFixed className="h-3.5 w-3.5" /> No firearms are checked out right now.
          </p>
        )}
      </div>
    </div>
  );
}
