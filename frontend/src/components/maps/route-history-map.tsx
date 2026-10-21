"use client";

import { MapContainer, TileLayer, Marker, Popup, ZoomControl, Circle, useMap } from "react-leaflet";
import { useEffect, useMemo } from "react";
import L from "leaflet";
import "./leaflet-guards";
import { MapPin } from "lucide-react";
import { fmtRelative, cn } from "@/lib/utils";
import { useMapMountKey } from "./use-map-mount-key";
import { MapResizeObserver } from "./map-resize-observer";
import { TILE_ATTRIBUTION, TILE_DARKEN_CLASS, TILE_MAX_ZOOM, TILE_URL } from "./tiles";
import { RoadTrailLayer, TrailModeToggle, useRoadTrail, useTrailMode, type TrailFix } from "./road-trail";

// Fix default Leaflet icon paths
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const startIcon = L.divIcon({
  className: "armory-marker",
  html: `<div class="h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-emerald-800 shadow-[0_0_10px_rgba(52,211,153,0.9)]"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const endIcon = L.divIcon({
  className: "armory-marker",
  html: `<div class="h-3.5 w-3.5 rounded-full bg-red-400 ring-2 ring-red-800 shadow-[0_0_10px_rgba(239,68,68,0.9)]"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

interface GpsPoint {
  gps_log_id: number;
  captured_at: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  speed_mps: number | null;
  is_inside_geofence: boolean;
}

interface Geofence {
  location_id: number;
  location_name: string;
  center_latitude: number;
  center_longitude: number;
  radius_meters: number;
  is_armory: boolean;
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(L.latLngBounds(points.map(p => L.latLng(p[0], p[1]))).pad(0.2));
  }, [points, map]);
  return null;
}

interface Props {
  history: GpsPoint[];
  geofences?: Geofence[];
}

export function RouteHistoryMap({ history, geofences = [] }: Props) {
  const mapKey = useMapMountKey();
  const lat = Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LAT ?? 8.484460);
  const lon = Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LON ?? 124.657010);

  const positions = useMemo<[number, number][]>(
    () => history.map(p => [Number(p.latitude), Number(p.longitude)]),
    [history]
  );

  const first = history.length > 0 ? history[history.length - 1] : null; // oldest
  const last = history.length > 0 ? history[0] : null; // newest (sorted desc)

  /* Time order (oldest first) for the road-snapped trail. */
  const trailFixes = useMemo<TrailFix[]>(
    () =>
      [...history].reverse().map((p) => ({
        lat: Number(p.latitude),
        lon: Number(p.longitude),
        time: p.captured_at ? Date.parse(p.captured_at) / 1000 : undefined,
      })),
    [history]
  );
  const [trailMode, setTrailMode] = useTrailMode();
  const roadTrail = useRoadTrail(trailFixes, trailMode === "roads");

  if (!mapKey) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-steel-400">
        Initialising map…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <MapContainer
        key={mapKey}
        center={positions.length > 0 ? positions[0] : [lat, lon]}
        zoom={15}
        zoomControl={false}
        className={`h-full w-full ${TILE_DARKEN_CLASS}`}
        scrollWheelZoom
      >
        <MapResizeObserver />
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={TILE_MAX_ZOOM} />
        <ZoomControl position="topright" />

        {geofences.map((g) => (
          <Circle
            key={g.location_id}
            center={[Number(g.center_latitude), Number(g.center_longitude)]}
            radius={Number(g.radius_meters)}
            pathOptions={{ color: g.is_armory ? "#aeb771" : "#60a5fa", weight: 1.2, fillOpacity: 0.04, dashArray: "4 6" }}
          >
            <Popup className="tactical-popup">
              <div className="w-[190px] p-2.5 text-steel-100 font-sans text-xs select-text">
                <p className="font-bold text-sm text-olive-100 truncate">{g.location_name}</p>
                <p className="text-[10px] text-steel-400 mt-0.5">{g.radius_meters}m radius {g.is_armory ? "· Armory Facility" : "· Geofence Zone"}</p>
              </div>
            </Popup>
          </Circle>
        ))}

        <RoadTrailLayer fixes={trailFixes} mode={trailMode} segments={roadTrail.segments} />

        {first && (
          <Marker position={[Number(first.latitude), Number(first.longitude)]} icon={startIcon}>
            <Popup className="tactical-popup">
              <div className="w-[190px] p-2.5 text-steel-100 font-sans text-xs select-text">
                <div className="flex items-center gap-1.5 text-emerald-400 font-bold mb-1">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <span>Route Start</span>
                </div>
                <p className="text-[10px] text-steel-300 font-mono">
                  {Number(first.latitude).toFixed(5)}, {Number(first.longitude).toFixed(5)}
                </p>
                <p className="text-[10px] text-steel-400 mt-1">{fmtRelative(first.captured_at)}</p>
              </div>
            </Popup>
          </Marker>
        )}

        {last && last !== first && (
          <Marker position={[Number(last.latitude), Number(last.longitude)]} icon={endIcon}>
            <Popup className="tactical-popup">
              <div className="w-[190px] p-2.5 text-steel-100 font-sans text-xs select-text">
                <div className="flex items-center gap-1.5 text-red-400 font-bold mb-1">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <span>Latest Fix</span>
                </div>
                <p className="text-[10px] text-steel-300 font-mono">
                  {Number(last.latitude).toFixed(5)}, {Number(last.longitude).toFixed(5)}
                </p>
                <p className="text-[10px] text-steel-400 mt-1">{fmtRelative(last.captured_at)}</p>
              </div>
            </Popup>
          </Marker>
        )}

        <FitBounds points={positions} />
      </MapContainer>
      {trailFixes.length > 1 && (
        <TrailModeToggle className="right-3 bottom-7" mode={trailMode} onChange={setTrailMode} status={roadTrail.status} />
      )}
    </div>
  );
}
