"use client";

import { MapContainer, TileLayer, Circle, Marker, Tooltip, useMapEvents, useMap, ZoomControl } from "react-leaflet";
import { useEffect, useState } from "react";
import L from "leaflet";
import { Loader2, LocateFixed, MapPin, Search, X } from "lucide-react";
import "./leaflet-guards";
import { useMapMountKey } from "./use-map-mount-key";
import { MapResizeObserver } from "./map-resize-observer";
import { TILE_ATTRIBUTION, TILE_DARKEN_CLASS, TILE_MAX_ZOOM, TILE_URL } from "./tiles";

// Fix default Leaflet icon paths
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

export interface OtherZone {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius: number;
}

interface GeofencePickerProps {
  /** The zone's centre, or null while none is set. */
  latitude: number | null;
  longitude: number | null;
  radius: number;
  onChange: (lat: number, lng: number) => void;
  /** The zones that already exist, drawn faintly for reference. */
  otherZones?: OtherZone[];
  /** The map's height classes. */
  mapClassName?: string;
}

interface Place {
  lat: number;
  lng: number;
  name: string;
  detail: string;
}

/** A request to frame the zone; a new object each time so the same spot can be framed twice. */
type Frame = { lat: number; lng: number; radius: number };

function ClickHandler({ onChange }: { onChange: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onChange(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** Zooms so the whole circle fits, with some room around it. */
function FrameZone({ frame }: { frame: Frame | null }) {
  const map = useMap();
  useEffect(() => {
    if (!frame) return;
    map.fitBounds(L.latLng(frame.lat, frame.lng).toBounds(Math.max(frame.radius, 100) * 2.6), { animate: true });
  }, [frame, map]);
  return null;
}

/** Brings the pin back into view when it is moved off screen, e.g. by typed coordinates. */
function KeepInView({ lat, lng }: { lat: number | null; lng: number | null }) {
  const map = useMap();
  useEffect(() => {
    if (lat == null || lng == null) return;
    if (!map.getBounds().contains([lat, lng])) map.panTo([lat, lng], { animate: true });
  }, [lat, lng, map]);
  return null;
}

/**
 * Where the zone is: search for a place, use this device's location, or click the map. The pin
 * can be dragged to fine-tune it, and the circle shows the area the zone covers.
 */
export function GeofencePicker({
  latitude,
  longitude,
  radius,
  onChange,
  otherZones = [],
  mapClassName = "h-[280px] sm:h-[320px]",
}: GeofencePickerProps) {
  const mapKey = useMapMountKey();
  const defaultLat = Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LAT ?? 8.484460);
  const defaultLon = Number(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER_LON ?? 124.657010);
  const hasPoint = latitude != null && longitude != null;

  const [frame, setFrame] = useState<Frame | null>(hasPoint ? { lat: latitude, lng: longitude, radius } : null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function place(lat: number, lng: number) {
    onChange(lat, lng);
    setFrame({ lat, lng, radius });
    setMessage(null);
  }

  async function search() {
    const term = query.trim();
    if (!term) return;
    setSearching(true);
    setMessage(null);
    setResults(null);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ph&accept-language=en&q=${encodeURIComponent(term)}`;
      const rows: { lat: string; lon: string; name?: string; display_name: string }[] = await (await fetch(url)).json();
      const places = rows.map((r) => {
        const parts = r.display_name.split(", ");
        return { lat: Number(r.lat), lng: Number(r.lon), name: r.name || parts[0], detail: parts.slice(1, 4).join(", ") };
      });
      if (places.length === 0) setMessage(`No place found for "${term}". Try a nearby barangay or landmark, or click the map.`);
      else setResults(places);
    } catch {
      setMessage("Place search is not available right now. Click the map instead.");
    } finally {
      setSearching(false);
    }
  }

  function choose(p: Place) {
    place(p.lat, p.lng);
    setQuery(p.name);
    setResults(null);
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setMessage("This browser can't share its location. Search for the place or click the map.");
      return;
    }
    setLocating(true);
    setMessage(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        place(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        setLocating(false);
        setMessage("Couldn't get your location. Allow location access in the browser, or search for the place.");
      },
      { enableHighAccuracy: true, timeout: 15_000 }
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel-500" aria-hidden />
          <input
            className="input-field w-full pl-9 pr-9"
            placeholder="Search a place, e.g. Lumbia"
            aria-label="Search a place"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setResults(null); }}
            // This sits inside the zone form, so Enter searches instead of submitting it.
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } if (e.key === "Escape") setResults(null); }}
          />
          {searching ? (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-steel-400" aria-label="Searching" />
          ) : query ? (
            <button
              type="button"
              onClick={() => { setQuery(""); setResults(null); setMessage(null); }}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-steel-400 hover:text-steel-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}

          {results && (
            <ul className="absolute left-0 right-0 top-full z-[1000] mt-1 overflow-hidden rounded-lg border border-steel-700 bg-[#131a20] shadow-2xl shadow-black/60">
              {results.map((p, n) => (
                <li key={n}>
                  <button
                    type="button"
                    onClick={() => choose(p)}
                    className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-steel-800/70"
                  >
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-olive-400" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-olive-50">{p.name}</span>
                      <span className="block truncate text-[11px] text-steel-400">{p.detail}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" onClick={search} disabled={!query.trim() || searching} className="btn-secondary shrink-0 text-xs">
          Search
        </button>
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          className="btn-secondary shrink-0 text-xs"
          title="Use where this device is now, if you are standing at the place"
        >
          {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <LocateFixed className="h-4 w-4" />}
          <span className="hidden sm:inline">My location</span>
        </button>
      </div>

      {message && <p className="text-[11px] text-amber-300">{message}</p>}

      {!mapKey ? (
        <div className={`flex ${mapClassName} w-full items-center justify-center rounded-lg border border-steel-700/40 text-xs text-steel-400`}>
          Loading map…
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-lg border border-steel-700/40">
          <MapContainer
            key={mapKey}
            center={hasPoint ? [latitude, longitude] : [defaultLat, defaultLon]}
            zoom={15}
            zoomControl={false}
            className={`${mapClassName} w-full ${TILE_DARKEN_CLASS}`}
            scrollWheelZoom
          >
            <MapResizeObserver />
            <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} maxZoom={TILE_MAX_ZOOM} />
            <ZoomControl position="topright" />
            <ClickHandler onChange={onChange} />
            <FrameZone frame={frame} />
            <KeepInView lat={latitude} lng={longitude} />

            {otherZones.map((z) => (
              <Circle
                key={z.id}
                center={[z.lat, z.lng]}
                radius={z.radius}
                pathOptions={{ color: "#7c8a99", weight: 1, fillOpacity: 0.06 }}
              >
                <Tooltip sticky>{z.name}</Tooltip>
              </Circle>
            ))}

            {hasPoint && (
              <>
                <Marker
                  position={[latitude, longitude]}
                  draggable
                  eventHandlers={{
                    dragend: (e) => {
                      const p = (e.target as L.Marker).getLatLng();
                      onChange(p.lat, p.lng);
                    },
                  }}
                />
                {radius > 0 && (
                  <Circle
                    center={[latitude, longitude]}
                    radius={radius}
                    pathOptions={{ color: "#aeb771", weight: 2, fillOpacity: 0.15 }}
                  />
                )}
              </>
            )}
          </MapContainer>

          {/* What to do next, in the corner away from the zoom buttons and the credits */}
          <p className="pointer-events-none absolute left-2 top-2 z-[500] max-w-[calc(100%-4.5rem)] rounded-md bg-steel-950/85 px-2.5 py-1 text-[11px] text-steel-200 shadow">
            {hasPoint ? "Drag the pin or click elsewhere to move the zone" : "Click the map where the centre of the zone is"}
          </p>
        </div>
      )}
    </div>
  );
}
