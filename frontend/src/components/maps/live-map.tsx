"use client";

import { MapContainer, TileLayer, Marker, Popup, Circle, ZoomControl, useMap } from "react-leaflet";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "./leaflet-guards";
import Link from "next/link";
import { ArrowRight, Crosshair, LocateFixed, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { fmtRelative, cn } from "@/lib/utils";
import { useMapMountKey } from "./use-map-mount-key";
import { MapResizeObserver } from "./map-resize-observer";
import { TILE_ATTRIBUTION, TILE_DARKEN_CLASS, TILE_MAX_ZOOM, TILE_URL } from "./tiles";
import { RoadTrailLayer, TrailModeToggle, useRoadTrail, useTrailMode, type TrailFix } from "./road-trail";

// Fix default Leaflet icon paths under bundlers like Webpack / Turbopack
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function createLocationPin({
  fill,
  stroke,
  core,
  label,
  dashed = false,
}: {
  fill: string;
  stroke: string;
  core: string;
  label: string;
  dashed?: boolean;
}) {
  return L.divIcon({
    className: "armory-marker",
    html: `<svg viewBox="0 0 30 38" width="30" height="38" aria-label="${label}" role="img">
      <path
        d="M15 1C7.82 1 2 6.82 2 14c0 9.5 13 23 13 23s13-13.5 13-23C28 6.82 22.18 1 15 1Z"
        fill="${fill}"
        stroke="${stroke}"
        stroke-width="2"
        ${dashed ? 'stroke-dasharray="3 2"' : ""}
      />
      <circle cx="15" cy="14" r="5" fill="${core}" stroke="rgba(0,0,0,.45)" stroke-width="1.5" />
    </svg>`,
    iconSize: [30, 38],
    // The pointed tip is the exact GPS coordinate.
    iconAnchor: [15, 37],
    popupAnchor: [0, -34],
  });
}

const tactical = createLocationPin({
  fill: "#77833e",
  stroke: "#dce6a0",
  core: "#f5f7dc",
  label: "Live firearm location",
});

const overdueMarker = createLocationPin({
  fill: "#b91c1c",
  stroke: "#fecaca",
  core: "#fff1f2",
  label: "Overdue firearm location",
});

const staleMarker = createLocationPin({
  fill: "#b45309",
  stroke: "#fde68a",
  core: "#fffbeb",
  label: "Last known firearm location",
});

const placeholderMarker = createLocationPin({
  fill: "#475569",
  stroke: "#cbd5e1",
  core: "#f1f5f9",
  label: "Placeholder firearm location",
  dashed: true,
});

interface LiveItem {
  equipment_id: number;
  serial_number: string;
  model: string;
  status: string;
  condition: string;
  assigned_to?: string | null;
  expected_return?: string | null;
  lat: number;
  lon: number;
  captured_at?: string | null;
  received_at?: string | null;
  inside_geofence?: boolean;
  /** Zones the shown position falls in; empty means outside all of them. */
  zones?: string[];
  battery_pct?: number | null;
  device_id?: string | null;
  iot_online: boolean;
  telemetry_source: "iot" | "stale" | "placeholder" | "missing";
  is_placeholder: boolean;
  is_stale: boolean;
  location_note: string;
}

interface Geofence {
  location_id: number;
  location_name: string;
  center_latitude: number;
  center_longitude: number;
  radius_meters: number;
  security_level: number;
  is_armory: boolean;
}

interface LiveResponse {
  items: LiveItem[];
  geofences: Geofence[];
  poll_interval: number;
  online_window_sec: number;
  updated_at: string;
}

/**
 * Frames all tracked firearms once, on the first poll that returns positions.
 * Re-fitting on every poll would fight the operator's own panning and zooming.
 */
function InitialFit({ points }: { points: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || points.length === 0) return;
    done.current = true;
    // A single point has no extent to fit; centre on it at street level instead.
    if (points.length === 1) {
      map.setView(points[0], 17);
      return;
    }
    map.fitBounds(L.latLngBounds(points.map((p) => L.latLng(p[0], p[1]))).pad(0.4));
  }, [points, map]);

  return null;
}

/**
 * Keeps the tracked firearm centred as new fixes arrive, and steps aside the
 * moment the operator drags or zooms the map themselves.
 */
function FollowTarget({
  position,
  active,
  onDisengage,
}: {
  position: [number, number] | null;
  active: boolean;
  onDisengage: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!active) return;

    // Programmatic pans also fire these events, so ignore the ones we cause.
    let ours = false;
    const release = () => { if (!ours) onDisengage(); };

    map.on("dragstart", release);
    map.on("zoomstart", release);

    if (position) {
      ours = true;
      map.panTo(position, { animate: true, duration: 0.6 });
      window.setTimeout(() => { ours = false; }, 800);
    }

    return () => {
      map.off("dragstart", release);
      map.off("zoomstart", release);
    };
  }, [map, position, active, onDisengage]);

  return null;
}

/**
 * @param focusId show only this firearm and follow it (e.g. "locate" from an overdue transaction).
 */
export function LiveMap({ focusId }: { focusId?: number } = {}) {
  const mapKey = useMapMountKey();
  const interval = Number(process.env.NEXT_PUBLIC_GPS_POLL_SECONDS ?? 30) * 1000;
  const lat = Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LAT ?? 8.484460);
  const lon = Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LON ?? 124.657010);

  /** equipment_id being followed; null means "show everything". */
  const [trackedId, setTrackedId] = useState<number | null>(focusId ?? null);
  const [following, setFollowing] = useState(true);

  const { data } = useQuery({
    queryKey: ["gps-live"],
    queryFn: async () => (await api.get<LiveResponse>("/gps/live")).data,
    // The device reports on a fixed cadence; honour whatever the API advertises.
    refetchInterval: (query) => {
      const advertised = query.state.data?.poll_interval;
      return advertised ? advertised * 1000 : interval;
    },
  });

  const items = useMemo(
    () => (data?.items ?? []).filter((i) => focusId == null || i.equipment_id === focusId),
    [data?.items, focusId]
  );

  /* Default to the first firearm sending live telemetry, then keep that choice. */
  const autoTarget = useMemo(() => {
    const live = items.find((i) => i.telemetry_source === "iot");
    return (live ?? items[0])?.equipment_id ?? null;
  }, [items]);

  const activeId = trackedId ?? autoTarget;
  const tracked = items.find((i) => i.equipment_id === activeId) ?? null;

  /* Breadcrumb trail comes from the server's own history, not client guesswork. */
  const { data: trail } = useQuery({
    queryKey: ["gps-trail", activeId],
    queryFn: async () =>
      (await api.get<{ latitude: number; longitude: number; captured_at: string }[]>(
        `/gps/history/${activeId}?limit=40`
      )).data,
    enabled: activeId != null,
    refetchInterval: (query) => {
      const advertised = query.state.data ? data?.poll_interval : undefined;
      return advertised ? advertised * 1000 : interval;
    },
  });

  /* The API returns newest first; the trail is drawn in time order and snapped to the roads. */
  const trailFixes = useMemo<TrailFix[]>(
    () =>
      [...(trail ?? [])].reverse().map((p) => ({
        lat: Number(p.latitude),
        lon: Number(p.longitude),
        time: p.captured_at ? Date.parse(p.captured_at) / 1000 : undefined,
      })),
    [trail]
  );
  const [trailMode, setTrailMode] = useTrailMode();
  const roadTrail = useRoadTrail(trailFixes, trailMode === "roads");

  const trackedPosition = useMemo<[number, number] | null>(
    () => (tracked ? [Number(tracked.lat), Number(tracked.lon)] : null),
    [tracked]
  );

  const disengage = useCallback(() => setFollowing(false), []);

  const points = useMemo<[number, number][]>(
    () => items.map(i => [Number(i.lat), Number(i.lon)] as [number, number]),
    [items]
  );
  const placeholderCount = items.filter((i) => i.is_placeholder).length;
  const staleCount = items.filter((i) => i.is_stale).length;
  const liveCount = items.filter((i) => i.telemetry_source === "iot").length;

  if (!mapKey) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-xs text-steel-400">
        Initialising map…
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden">
      <MapContainer
        key={mapKey}
        center={[lat, lon]}
        zoom={15}
        zoomControl={false}
        className={`absolute inset-0 h-full w-full ${TILE_DARKEN_CLASS}`}
        scrollWheelZoom
      >
        <MapResizeObserver />
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={TILE_MAX_ZOOM} />
        <ZoomControl position="topright" />

        {/* Path the tracked firearm has actually travelled, along the roads */}
        <RoadTrailLayer fixes={trailFixes} mode={trailMode} segments={roadTrail.segments} />

        {data?.geofences.map((g) => (
          <Circle
            key={g.location_id}
            center={[Number(g.center_latitude), Number(g.center_longitude)]}
            radius={Number(g.radius_meters)}
            pathOptions={{
              color: g.is_armory ? "#aeb771" : g.security_level === 2 ? "#f59e0b" : "#60a5fa",
              weight: 1.4,
              fillOpacity: 0.05,
              dashArray: "4 6",
            }}
          >
            <Popup className="tactical-popup" minWidth={180} maxWidth={210}>
              <div
                style={{ backgroundColor: "#131a20", color: "#f1f5f9" }}
                className="w-[190px] p-2.5 text-steel-100 font-sans text-xs select-text rounded-md"
              >
                <div className="flex items-center gap-1.5 mb-1.5 pb-1.5 border-b border-steel-800">
                  <span className="font-bold text-xs text-steel-100 truncate">{g.location_name}</span>
                </div>
                <div className="space-y-1 text-[10px]">
                  <div className="flex justify-between items-center">
                    <span className="text-steel-400">Security:</span>
                    <span className={cn("pill text-[9px] px-1.5 py-0.2", g.is_armory ? "pill-tactical" : g.security_level === 2 ? "pill-warn" : "pill-info")}>
                      {g.is_armory ? "Armory" : g.security_level === 2 ? "Restricted" : "Standard"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-steel-400">Radius:</span>
                    <span className="font-mono text-steel-300">{g.radius_meters}m</span>
                  </div>
                </div>
              </div>
            </Popup>
          </Circle>
        ))}

        {items.map((item) => (
          <Marker
            key={item.equipment_id}
            position={[Number(item.lat), Number(item.lon)]}
            icon={markerFor(item)}
            eventHandlers={{
              click: () => {
                setTrackedId(item.equipment_id);
                setFollowing(true);
              },
            }}
          >
            <Popup className="tactical-popup" minWidth={255} maxWidth={275}>
              <div
                style={{ backgroundColor: "#131a20", color: "#f1f5f9" }}
                className="w-[260px] p-3 text-steel-100 font-sans text-xs select-text rounded-md"
              >
                {/* Header Row: Title, Badge, and Close Button aligned horizontally */}
                <div className="flex items-center gap-2 pr-7 h-5">
                  <h4 className="m-0 font-bold text-xs text-steel-100 truncate tracking-tight leading-none min-w-0">
                    {item.model}
                  </h4>
                  <span
                    className={cn(
                      "pill shrink-0 text-[9px] font-semibold px-2 py-0.5 whitespace-nowrap leading-none",
                      item.status === "Available"
                        ? "pill-ok"
                        : item.status === "Checked Out"
                        ? "pill-info"
                        : item.status === "Overdue"
                        ? "pill-critical"
                        : "pill-warn"
                    )}
                  >
                    {item.status}
                  </span>
                </div>

                {/* Subtitle: Serial Number */}
                <div className="mt-1 pb-2 border-b border-steel-800">
                  <p className="font-mono text-[10px] text-steel-400 font-medium leading-none">
                    SN {item.serial_number}
                  </p>
                </div>

                {/* Formal Key-Value Specs */}
                <div className="space-y-1.5 py-2 text-[11px]">
                  {item.zones && item.telemetry_source !== "placeholder" && (
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-steel-400">Zone</span>
                      {item.zones.length > 0 ? (
                        <span className="text-emerald-300 font-medium truncate text-right" title={item.zones.join(", ")}>
                          {item.zones.join(", ")}
                        </span>
                      ) : (
                        <span className="text-red-300 font-semibold">Outside all zones</span>
                      )}
                    </div>
                  )}

                  <div className="flex justify-between items-center">
                    <span className="text-steel-400">Condition</span>
                    <span className="text-steel-200 font-medium">{item.condition}</span>
                  </div>

                  {item.assigned_to && (
                    <div className="flex justify-between items-center">
                      <span className="text-steel-400">Issued To</span>
                      <span className="text-steel-200 font-medium truncate max-w-[150px] text-right" title={item.assigned_to}>
                        {item.assigned_to}
                      </span>
                    </div>
                  )}

                  {item.device_id && (
                    <div className="flex justify-between items-center">
                      <span className="text-steel-400">Device</span>
                      <span className="font-mono text-[10px] text-steel-300 bg-steel-800/80 px-1.5 py-0.5 rounded border border-steel-700/60">
                        {item.device_id}
                      </span>
                    </div>
                  )}

                  {item.battery_pct != null && (
                    <div className="flex justify-between items-center">
                      <span className="text-steel-400">Battery</span>
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-1.5 bg-steel-800 rounded-full overflow-hidden border border-steel-700/60">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              item.battery_pct > 20 ? "bg-emerald-500" : "bg-red-500"
                            )}
                            style={{ width: `${Math.max(4, Math.min(100, item.battery_pct))}%` }}
                          />
                        </div>
                        <span className={cn("font-mono text-[10px] font-semibold", item.battery_pct > 20 ? "text-steel-300" : "text-red-400")}>
                          {item.battery_pct}%
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-between items-center">
                    <span className="text-steel-400">Telemetry</span>
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-steel-300">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          item.telemetry_source === "iot"
                            ? "bg-emerald-400"
                            : item.telemetry_source === "stale"
                            ? "bg-amber-400"
                            : item.telemetry_source === "missing"
                            ? "bg-red-400"
                            : "bg-steel-500"
                        )}
                      />
                      <span>{telemetryLabel(item.telemetry_source)}</span>
                    </span>
                  </div>

                  {item.location_note && (
                    <p className="text-[10px] text-steel-400 leading-snug pt-1 border-t border-steel-800/60" title={item.location_note}>
                      {item.location_note}
                    </p>
                  )}
                </div>

                {/* Coordinates & Fix Timestamp (never truncated) */}
                <div className="pt-2 border-t border-steel-800 flex items-center justify-between text-[10px] text-steel-400 font-mono">
                  <span title={`Lat/Lon: ${item.lat}, ${item.lon}`}>
                    {Number(item.lat).toFixed(5)}, {Number(item.lon).toFixed(5)}
                  </span>
                  {item.captured_at && (
                    <span className="text-steel-500 text-[10px]">
                      Fix {fmtRelative(item.captured_at)}
                    </span>
                  )}
                </div>

                {/* Footer Action Buttons - Perfectly consistent in both dimensions */}
                <div className="pt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (trackedId === item.equipment_id && following) {
                        setFollowing(false);
                      } else {
                        setTrackedId(item.equipment_id);
                        setFollowing(true);
                      }
                    }}
                    className={cn(
                      "h-7 flex-1 inline-flex items-center justify-center gap-1 rounded text-[11px] font-medium border transition shadow-sm",
                      trackedId === item.equipment_id && following
                        ? "bg-olive-800/90 text-olive-100 border-olive-500/70"
                        : "bg-steel-800 text-steel-200 border-steel-700 hover:bg-steel-700 hover:text-white"
                    )}
                    title={trackedId === item.equipment_id && following ? "Stop following" : "Follow on map"}
                  >
                    {trackedId === item.equipment_id && following ? (
                      <>
                        <LocateFixed className="h-3 w-3 text-olive-300 shrink-0" />
                        <span>Following</span>
                      </>
                    ) : (
                      <>
                        <Crosshair className="h-3 w-3 shrink-0" />
                        <span>Follow</span>
                      </>
                    )}
                  </button>

                  <Link
                    href={`/firearms/${item.equipment_id}`}
                    className="h-7 flex-1 inline-flex items-center justify-center gap-1.5 rounded text-[11px] font-semibold bg-olive-600 hover:bg-olive-500 active:bg-olive-700 !text-white border border-olive-500/70 shadow-sm transition text-center no-underline"
                  >
                    <span className="!text-white">Details</span>
                    <ArrowRight className="h-3 w-3 !text-white shrink-0" />
                  </Link>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        <InitialFit points={points} />
        <FollowTarget position={trackedPosition} active={following} onDisengage={disengage} />
      </MapContainer>

      {trailFixes.length > 1 && (
        <TrailModeToggle className="right-3 bottom-7" mode={trailMode} onChange={setTrailMode} status={roadTrail.status} />
      )}

      {/* Tracking control */}
      {tracked && (
        <button
          type="button"
          onClick={() => setFollowing((v) => !v)}
          aria-pressed={following}
          title={following ? "Stop following this firearm" : "Follow this firearm"}
          className={`absolute left-3 bottom-3 z-[500] flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition shadow-md backdrop-blur-sm ${
            following
              ? "border-olive-500/60 bg-olive-900/90 text-olive-100"
              : "border-steel-600/60 bg-steel-900/90 text-steel-300 hover:text-olive-200"
          }`}
        >
          {following ? <LocateFixed className="h-3.5 w-3.5" /> : <Crosshair className="h-3.5 w-3.5" />}
          {following ? "Following" : "Follow"} {tracked.serial_number}
        </button>
      )}

      {items.length > 0 && (
        <div className="pointer-events-none absolute left-3 top-3 z-[500] flex flex-wrap gap-1.5">
          <span className="pill pill-ok bg-steel-900/85">{liveCount} live</span>
          {staleCount > 0 && <span className="pill pill-warn bg-steel-900/85">{staleCount} last known</span>}
          {placeholderCount > 0 && <span className="pill pill-muted bg-steel-900/85">{placeholderCount} placeholder</span>}
          {data?.updated_at && (
            <span className="pill pill-muted bg-steel-900/85">updated {fmtRelative(data.updated_at)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function markerFor(item: LiveItem) {
  if (item.telemetry_source === "placeholder") return placeholderMarker;
  if (item.telemetry_source === "stale") return staleMarker;
  if (item.status === "Overdue" || item.zones?.length === 0) return overdueMarker;
  return tactical;
}

function telemetryLabel(source: LiveItem["telemetry_source"]): string {
  if (source === "iot") return "Live IoT";
  if (source === "stale") return "Last known";
  if (source === "placeholder") return "Placeholder";
  return "Missing";
}
