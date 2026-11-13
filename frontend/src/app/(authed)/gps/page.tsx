"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck, AlertTriangle, Search, X, ChevronDown, ChevronUp, User } from "lucide-react";
import { api } from "@/lib/api";
import { fmtRelative, cn } from "@/lib/utils";
import { TRIP_STAGE_LABEL, type TripStage } from "@/lib/trip";
import { BatteryBadge, BatteryDetails } from "@/components/gps/battery-status";

const LiveMap = dynamic(() => import("@/components/maps/live-map").then((m) => m.LiveMap), { ssr: false });
const RouteHistoryMap = dynamic(() => import("@/components/maps/route-history-map").then((m) => m.RouteHistoryMap), { ssr: false });

export default function GpsPage() {
  const [selectedFirearm, setSelectedFirearm] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "iot" | "stale" | "placeholder" | "alert">("all");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const { data } = useQuery({
    queryKey: ["gps-live"],
    queryFn: async () => (await api.get("/gps/live")).data,
    refetchInterval: 30_000,
  });

  const { data: history } = useQuery({
    queryKey: ["gps-history", selectedFirearm],
    queryFn: async () => (await api.get(`/gps/history/${selectedFirearm}`, { params: { limit: 500 } })).data,
    enabled: !!selectedFirearm,
  });

  const allItems: any[] = data?.items || [];

  const iotCount = allItems.filter((i) => i.telemetry_source === "iot").length;
  const staleCount = allItems.filter((i) => i.telemetry_source === "stale").length;
  const placeholderCount = allItems.filter((i) => i.telemetry_source === "placeholder").length;
  // On a trip, between zones is normal: the backend says when a firearm needs attention.
  const needsAttention = (i: any) => (i.needs_attention ?? i.inside_geofence === false) || i.status === "Overdue";
  const alertCount = allItems.filter(needsAttention).length;

  const filteredItems = useMemo(() => {
    return allItems.filter((i) => {
      // Telemetry / Status filter
      if (filterStatus === "iot" && i.telemetry_source !== "iot") return false;
      if (filterStatus === "stale" && i.telemetry_source !== "stale") return false;
      if (filterStatus === "placeholder" && i.telemetry_source !== "placeholder") return false;
      if (filterStatus === "alert" && !needsAttention(i)) return false;

      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchSerial = i.serial_number?.toLowerCase().includes(q);
        const matchModel = i.model?.toLowerCase().includes(q);
        const matchAssigned = i.assigned_to?.toLowerCase().includes(q);
        const matchDevice = i.device_id?.toLowerCase().includes(q);
        const matchStatus = i.status?.toLowerCase().includes(q);
        if (!matchSerial && !matchModel && !matchAssigned && !matchDevice && !matchStatus) {
          return false;
        }
      }
      return true;
    });
  }, [allItems, filterStatus, searchQuery]);

  const toggleExpand = (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllExpanded = () => {
    if (expandedIds.size === filteredItems.length && filteredItems.length > 0) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(filteredItems.map((i) => i.equipment_id)));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-olive-50">Real-Time GPS</h1>
        <p className="text-sm text-steel-400">
          Live coordinates come from ESP32 + GY-NEO6MV2 trackers. If a tracker is offline, the map labels the point as last known or placeholder.
        </p>
      </div>

      <div className="grid items-stretch gap-4 lg:grid-cols-12">
        {/* Map Panel */}
        <div className="glass relative h-[28rem] overflow-hidden rounded-xl p-2 sm:h-[34rem] lg:col-span-7 xl:col-span-8 2xl:col-span-8 lg:h-[75vh] lg:min-h-[38rem] lg:max-h-[50rem]">
          {selectedFirearm && history ? (
            <RouteHistoryMap history={history} geofences={data?.geofences} />
          ) : (
            <LiveMap />
          )}
        </div>

        {/* Sidebar Panel - flex column with pinned controls & independent scroll */}
        <div className="glass flex flex-col rounded-xl p-3.5 sm:p-4 h-[32rem] sm:h-[36rem] lg:col-span-5 xl:col-span-4 2xl:col-span-4 lg:h-[75vh] lg:min-h-[38rem] lg:max-h-[50rem]">
          {/* Pinned Header & Filter Bar */}
          <div className="shrink-0 space-y-2.5 pb-3 border-b border-steel-800/70">
            {/* Title, Counts & Expand/Collapse Toggle */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <p className="section-title truncate">Tracked Firearms</p>
                {allItems.length > 0 && (
                  <span className="font-mono text-[10px] text-olive-300 font-semibold bg-steel-800/90 border border-steel-700/60 px-2 py-0.5 rounded-full shrink-0">
                    {filteredItems.length}
                    {filteredItems.length !== allItems.length && ` / ${allItems.length}`}
                  </span>
                )}
              </div>
              {filteredItems.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAllExpanded}
                  className="px-2 py-0.5 rounded text-[10px] font-semibold border border-steel-700/60 bg-steel-800/80 text-steel-400 hover:text-steel-200 transition-colors shrink-0"
                >
                  {expandedIds.size === filteredItems.length ? "Collapse all" : "Expand all"}
                </button>
              )}
            </div>

            {/* Quick Telemetry Filters */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar text-[10px]">
              <button
                type="button"
                onClick={() => setFilterStatus("all")}
                className={cn(
                  "px-2 py-0.5 rounded font-medium transition-colors whitespace-nowrap",
                  filterStatus === "all"
                    ? "bg-olive-600 text-olive-50"
                    : "bg-steel-800/80 text-steel-400 hover:text-steel-200 hover:bg-steel-800"
                )}
              >
                All ({allItems.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterStatus("iot")}
                className={cn(
                  "px-2 py-0.5 rounded font-medium transition-colors whitespace-nowrap flex items-center gap-1",
                  filterStatus === "iot"
                    ? "bg-emerald-900/60 text-emerald-200 border border-emerald-500/60"
                    : "bg-steel-800/80 text-steel-400 hover:text-steel-200 hover:bg-steel-800"
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Live ({iotCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterStatus("stale")}
                className={cn(
                  "px-2 py-0.5 rounded font-medium transition-colors whitespace-nowrap flex items-center gap-1",
                  filterStatus === "stale"
                    ? "bg-amber-900/60 text-amber-200 border border-amber-500/60"
                    : "bg-steel-800/80 text-steel-400 hover:text-steel-200 hover:bg-steel-800"
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Stale ({staleCount})
              </button>
              {placeholderCount > 0 && (
                <button
                  type="button"
                  onClick={() => setFilterStatus("placeholder")}
                  className={cn(
                    "px-2 py-0.5 rounded font-medium transition-colors whitespace-nowrap flex items-center gap-1",
                    filterStatus === "placeholder"
                      ? "bg-steel-700 text-steel-100 border border-steel-500/60"
                      : "bg-steel-800/80 text-steel-400 hover:text-steel-200 hover:bg-steel-800"
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-steel-400" />
                  Placeholder ({placeholderCount})
                </button>
              )}
              {alertCount > 0 && (
                <button
                  type="button"
                  onClick={() => setFilterStatus("alert")}
                  className={cn(
                    "px-2 py-0.5 rounded font-medium transition-colors whitespace-nowrap flex items-center gap-1",
                    filterStatus === "alert"
                      ? "bg-red-900/60 text-red-200 border border-red-500/60"
                      : "bg-steel-800/80 text-red-400 hover:text-red-200 hover:bg-steel-800"
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                  Alerts ({alertCount})
                </button>
              )}
            </div>

            {/* Real-time Search Box */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-steel-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search serial, model, officer..."
                className="w-full bg-steel-900/80 border border-steel-700/60 rounded-md pl-8 pr-7 py-1 text-xs text-steel-100 placeholder:text-steel-400 focus:outline-none focus:border-olive-500/60 focus:ring-1 focus:ring-olive-500/40"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-steel-400 hover:text-steel-200 p-0.5"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Pinned Back to Live Map Action */}
            {selectedFirearm && (
              <button
                onClick={() => setSelectedFirearm(null)}
                className="btn-secondary text-xs w-full flex items-center justify-center gap-1.5 py-1.5 shadow-sm border border-steel-700/70 hover:border-olive-500/50 transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5 text-steel-300" />
                <span>Back to Live Map</span>
              </button>
            )}
          </div>

          {/* Scrollable Firearms List */}
          <div className="flex-1 overflow-y-auto min-h-0 pt-3 space-y-2.5 pr-1">
            {allItems.length === 0 && (
              <div className="p-4 text-center rounded-lg border border-steel-800 bg-steel-900/30 text-steel-400 text-xs">
                No firearms currently tracked.
              </div>
            )}

            {allItems.length > 0 && filteredItems.length === 0 && (
              <div className="p-4 text-center rounded-lg border border-steel-800 bg-steel-900/30 text-steel-400 text-xs space-y-1.5">
                <p>No firearms match your search or filter.</p>
                <button
                  type="button"
                  onClick={() => { setSearchQuery(""); setFilterStatus("all"); }}
                  className="text-[11px] text-olive-400 hover:text-olive-300 underline font-medium"
                >
                  Clear search & filters
                </button>
              </div>
            )}

            <ul className="space-y-2.5">
              {filteredItems.map((i: any) => {
                const isSelected = selectedFirearm === i.equipment_id;
                const isExpanded = expandedIds.has(i.equipment_id);
                const statusInfo = statusColor(i.status);
                const telemetryInfo = telemetryColor(i.telemetry_source);

                return (
                  <li
                    key={i.equipment_id}
                    className={cn(
                      "group rounded-xl border p-3.5 cursor-pointer transition-all duration-150 select-none shadow-sm",
                      isSelected
                        ? "border-olive-500/80 bg-olive-950/40 ring-1 ring-olive-500/50"
                        : "border-steel-800/80 bg-steel-900/60 hover:border-olive-600/50 hover:bg-steel-800/40"
                    )}
                    onClick={() => setSelectedFirearm(isSelected ? null : i.equipment_id)}
                  >
                    {/* Row 1: Serial Number (Left) & Operational Status (Right) */}
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-mono text-xs font-bold text-olive-100 tracking-wider uppercase">
                        {i.serial_number}
                      </h3>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", statusInfo.dot)} />
                        <span className={cn("text-[10px] font-bold tracking-wider uppercase", statusInfo.text)}>
                          {i.status}
                        </span>
                      </div>
                    </div>

                    {/* Row 2: Gun Model (Left - ample space, never cut) & Telemetry Status (Right) */}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-steel-200 truncate" title={i.model}>
                        {i.model}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", telemetryInfo.dot)} />
                        <span className={cn("text-[10px] font-medium tracking-wide uppercase", telemetryInfo.text)}>
                          {telemetryLabel(i.telemetry_source)}
                        </span>
                      </div>
                    </div>

                    {/* Row 3: Personnel (No "Issued to" text) & Quick Info + Dropdown Action */}
                    <div className="mt-2.5 pt-2 border-t border-steel-800/60 flex items-center justify-between text-[11px]">
                      {/* Personnel name with subtle user icon, no "Issued to" text */}
                      <div className="flex items-center gap-1.5 text-steel-300 min-w-0 pr-2">
                        <User className="h-3.5 w-3.5 text-steel-400 shrink-0" />
                        <span
                          className={cn(
                            "text-xs truncate",
                            i.assigned_to ? "text-steel-100 font-semibold" : "text-steel-400 italic"
                          )}
                          title={i.assigned_to ?? "Unassigned"}
                        >
                          {i.repair ? `For repair: ${i.assigned_to}` : i.assigned_to ?? "Unassigned"}
                        </span>
                      </div>

                      {/* Right: Battery, Geofence Alert, More details toggle */}
                      <div className="flex items-center gap-2.5 shrink-0">
                        <BatteryBadge pct={i.battery_pct} absent={i.battery_absent} />
                        {(i.needs_attention ?? i.inside_geofence === false) && (
                          <span title="Needs attention" className="inline-flex text-amber-400">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => toggleExpand(i.equipment_id, e)}
                          className="text-[10px] text-olive-400 hover:text-olive-300 flex items-center gap-0.5 font-medium transition-colors focus:outline-none"
                        >
                          <span>{isExpanded ? "Less details" : "More details"}</span>
                          {isExpanded ? (
                            <ChevronUp className="h-3.5 w-3.5 text-olive-400" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-olive-400" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Route Active Badge if selected */}
                    {isSelected && (
                      <div className="mt-2 pt-1.5 border-t border-olive-500/30 flex items-center justify-between text-[9px] text-olive-300 font-semibold uppercase tracking-wider">
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-olive-400 animate-ping" />
                          Route History Active
                        </span>
                        <span className="lowercase text-steel-400 font-normal">click to close</span>
                      </div>
                    )}

                    {/* Dropdown: Expanded Formal Specs */}
                    {isExpanded && (
                      <div
                        className="mt-3 pt-2.5 border-t border-steel-800/70 space-y-2 animate-fade-in text-[11px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="space-y-1.5">
                          <div className="flex justify-between items-center">
                            <span className="text-steel-400">{i.repair ? "Received for Repair" : "Personnel"}</span>
                            <span className="text-steel-200 font-medium truncate max-w-[170px] text-right" title={i.assigned_to ?? "Unassigned"}>
                              {i.assigned_to ?? "Unassigned"}
                            </span>
                          </div>
                          {i.condition && (
                            <div className="flex justify-between items-center">
                              <span className="text-steel-400">Condition</span>
                              <span className="text-steel-200 font-medium">{i.condition}</span>
                            </div>
                          )}

                          {i.device_id && (
                            <div className="flex justify-between items-center">
                              <span className="text-steel-400">Device ID</span>
                              <span className="font-mono text-[10px] text-steel-200">
                                {i.device_id}
                              </span>
                            </div>
                          )}

                          <BatteryDetails pct={i.battery_pct} mv={i.battery_mv} absent={i.battery_absent} reportedAt={i.battery_reported_at} label="Battery Level" />

                          {i.telemetry_source !== "placeholder" && (
                            <div className="flex justify-between items-center">
                              <span className="text-steel-400">Geofence Status</span>
                              {i.destination ? (
                                <span className={cn(
                                  "inline-flex items-center gap-1 text-[10px] font-semibold text-right",
                                  i.needs_attention ? "text-amber-400" : "text-emerald-400"
                                )}>
                                  {i.needs_attention
                                    ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    : <ShieldCheck className="h-3.5 w-3.5 shrink-0" />}
                                  {i.needs_attention ? "Off route" : "On route"} · {i.destination}
                                  {i.trip_stage ? ` (${TRIP_STAGE_LABEL[i.trip_stage as TripStage]})` : ""}
                                </span>
                              ) : i.inside_geofence ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
                                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                                  Inside Zone
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-400">
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                                  Outside Zone
                                </span>
                              )}
                            </div>
                          )}

                          {i.location_note && (
                            <p className="text-[10px] text-steel-400/90 leading-tight pt-1 border-t border-steel-800/50" title={i.location_note}>
                              {i.location_note}
                            </p>
                          )}
                        </div>

                        {/* Footer: Coordinates & Last Fix */}
                        <div className="pt-2 border-t border-steel-800/70 flex items-center justify-between text-[10px] text-steel-400 font-mono">
                          <span title={`Coordinates: ${i.lat}, ${i.lon}`}>
                            {i.lat != null && i.lon != null ? `${Number(i.lat).toFixed(5)}, ${Number(i.lon).toFixed(5)}` : "No coordinates"}
                          </span>
                          <span className="text-steel-500 text-[10px]">
                            {i.captured_at ? `Fix ${fmtRelative(i.captured_at)}` : "No live fix"}
                          </span>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function statusColor(status: string) {
  if (status === "Available") return { text: "text-emerald-400", dot: "bg-emerald-400" };
  if (status === "Checked Out") return { text: "text-blue-400", dot: "bg-blue-400" };
  if (status === "Overdue") return { text: "text-red-400", dot: "bg-red-400" };
  return { text: "text-amber-400", dot: "bg-amber-400" };
}

function telemetryColor(source: string) {
  if (source === "iot") return { text: "text-emerald-400", dot: "bg-emerald-400" };
  if (source === "stale") return { text: "text-amber-400", dot: "bg-amber-400" };
  if (source === "placeholder") return { text: "text-steel-400", dot: "bg-steel-400" };
  return { text: "text-red-400", dot: "bg-red-400" };
}

function telemetryLabel(source: string): string {
  if (source === "iot") return "Live IoT";
  if (source === "stale") return "Last Known";
  if (source === "placeholder") return "Placeholder";
  return "Missing";
}
