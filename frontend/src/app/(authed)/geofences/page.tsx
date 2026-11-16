"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Minus, Trash2, MapPin, Loader2, Pencil, X, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuthStore, hasRole } from "@/store/auth";
import { DataError } from "@/components/ui/data-error";
import { PasswordConfirmModal } from "@/components/ui/password-confirm-modal";
import { ZoneOccupancy } from "@/components/maps/zone-occupancy";

const GeofencePicker = dynamic(
  () => import("@/components/maps/geofence-picker").then((m) => m.GeofencePicker),
  { ssr: false, loading: () => <div className="h-[350px] lg:h-[442px] rounded-lg bg-steel-900/60 flex items-center justify-center text-steel-400 text-xs">Loading map…</div> }
);

interface GpsLocation {
  location_id: number;
  location_name: string;
  center_latitude: number;
  center_longitude: number;
  radius_meters: number;
  is_armory: boolean;
  /** Part of the camp: issued firearms leave from and return to it. Armory zones count as camp too. */
  is_camp: boolean;
  description: string | null;
}

export default function GeofencesPage() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canManage = hasRole(user, "Administrator", "S4 Officer");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<GpsLocation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GpsLocation | null>(null);

  const { data: locations, isLoading, isError, refetch } = useQuery({
    queryKey: ["geofences"],
    queryFn: async () => (await api.get<GpsLocation[]>("/locations")).data,
  });

  const [form, setForm] = useState({
    location_name: "",
    latitude: "",
    longitude: "",
    radius_meters: 500,
    is_armory: false,
    is_camp: false,
    description: "",
  });

  // Coordinates are normally set from the map; typing them is the fallback for a GPS reading.
  const [typeCoords, setTypeCoords] = useState(false);
  const lat = parseFloat(form.latitude);
  const lng = parseFloat(form.longitude);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  function resetForm() {
    setForm({ location_name: "", latitude: "", longitude: "", radius_meters: 500, is_armory: false, is_camp: false, description: "" });
    setEditing(null);
    setShowForm(false);
    setTypeCoords(false);
  }

  function startEdit(loc: GpsLocation) {
    setForm({
      location_name: loc.location_name,
      latitude: String(loc.center_latitude),
      longitude: String(loc.center_longitude),
      radius_meters: loc.radius_meters,
      is_armory: loc.is_armory,
      is_camp: loc.is_camp,
      description: loc.description ?? "",
    });
    setEditing(loc);
    setShowForm(true);
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        location_name: form.location_name,
        center_latitude: parseFloat(form.latitude),
        center_longitude: parseFloat(form.longitude),
        radius_meters: form.radius_meters,
        is_armory: form.is_armory,
        is_camp: form.is_camp,
        description: form.description || null,
        security_level: 1,
      };
      if (editing) {
        return api.patch(`/locations/${editing.location_id}`, payload);
      }
      return api.post("/locations", payload);
    },
    onSuccess: () => {
      toast.success(editing ? "Geofence updated." : "Geofence created.");
      qc.invalidateQueries({ queryKey: ["geofences"] });
      qc.invalidateQueries({ queryKey: ["locations"] });
      resetForm();
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? "Failed."),
  });

  // Errors are shown inside the password dialog, which stays open until the password is right.
  const remove = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => api.delete(`/locations/${id}`, { data: { password } }),
    onSuccess: () => {
      toast.success("Geofence deleted.");
      qc.invalidateQueries({ queryKey: ["geofences"] });
      qc.invalidateQueries({ queryKey: ["locations"] });
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2">
            <MapPin className="h-5 w-5 text-olive-300" /> Geofence Management
          </h1>
          <p className="text-sm text-steel-400">
            Manage camp and destination zones, track firearms, and monitor movement alerts.
          </p>
        </div>
        {canManage && (
          <button onClick={() => { resetForm(); setShowForm((s) => !s); }} className="btn-primary shrink-0 whitespace-nowrap">
            <Plus className="h-4 w-4" /> New Geofence
          </button>
        )}
      </div>

      <ZoneOccupancy />

      {showForm && canManage && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={resetForm}>
          {/* Two columns on wide screens so everything fits without scrolling; a phone stacks them. */}
          <div className="glass w-full max-w-5xl rounded-xl p-5 max-lg:max-h-[calc(100vh-2rem)] max-lg:overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
              <div className="flex justify-between items-center">
                <p className="section-title">{editing ? `Edit: ${editing.location_name}` : "Create Geofence"}</p>
                <button type="button" onClick={resetForm} className="btn-ghost text-xs" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
              </div>

              <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                {/* Left: what the zone is and how big */}
                <div className="space-y-3">
                  <p className="text-[10px] uppercase tracking-widest text-olive-300">Zone Information</p>
                  <div>
                    <label htmlFor="zone-name" className="text-xs text-steel-400 mb-1 block">Zone Name</label>
                    <input id="zone-name" className="input-field w-full" required placeholder="e.g. Lumbia Firing Range"
                           value={form.location_name} onChange={(e) => setForm({ ...form, location_name: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Type</label>
                    <div role="radiogroup" aria-label="Zone type" className="grid grid-cols-3 gap-2">
                      {ZONE_TYPES.map((t) => (
                        <TypeOption key={t.value} label={t.label} on={zoneType(form) === t.value}
                                    onClick={() => setForm({ ...form, is_armory: t.value === "armory", is_camp: t.value === "camp" })} />
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] text-steel-500">
                      {ZONE_TYPES.find((t) => t.value === zoneType(form))?.hint}
                    </p>
                  </div>
                  <div>
                    <label htmlFor="zone-description" className="text-xs text-steel-400 mb-1 block">Description</label>
                    <input id="zone-description" className="input-field w-full" placeholder="Optional description"
                           value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                  </div>

                  <div>
                    <label className="text-xs text-steel-400 mb-1 block">Zone size</label>
                    {/* Common sizes first; the exact radius below for anything else */}
                    <div role="radiogroup" aria-label="Zone size" className="grid grid-cols-4 gap-2">
                      {SIZE_PRESETS.map((s) => {
                        const on = form.radius_meters === s.radius;
                        return (
                          <button
                            key={s.radius}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => setForm({ ...form, radius_meters: s.radius })}
                            className={cn(
                              "rounded-md border px-1 py-1.5 text-center transition-colors",
                              on
                                ? "border-olive-500 bg-olive-600/30 text-olive-100"
                                : "border-steel-700/40 bg-steel-900/60 text-steel-300 hover:border-steel-600"
                            )}
                          >
                            <span className="block text-xs font-medium">{s.label}</span>
                            <span className={cn("block text-[10px]", on ? "text-olive-200/80" : "text-steel-500")}>{acrossText(s.radius)}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-2 flex items-center gap-3">
                      <div className="flex shrink-0 items-center rounded-md border border-steel-700/40 bg-steel-900/60">
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, radius_meters: Math.max(10, form.radius_meters - radiusStep(form.radius_meters - 1)) })}
                          disabled={form.radius_meters <= 10}
                          aria-label="Smaller"
                          className="flex h-9 w-9 items-center justify-center text-steel-300 hover:text-olive-200 disabled:opacity-30"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <input
                          type="number"
                          min={10}
                          required
                          aria-label="Radius in metres"
                          value={form.radius_meters}
                          onChange={(e) => setForm({ ...form, radius_meters: Number(e.target.value) })}
                          className="h-9 w-16 border-x border-steel-700/40 bg-transparent text-center text-sm text-olive-50 outline-none [appearance:textfield] focus:bg-steel-800/60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, radius_meters: form.radius_meters + radiusStep(form.radius_meters) })}
                          aria-label="Bigger"
                          className="flex h-9 w-9 items-center justify-center text-steel-300 hover:text-olive-200"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                      <p className="text-[11px] leading-snug text-steel-500">
                        metres from the centre. Make the circle on the map cover the whole place.
                      </p>
                    </div>
                  </div>

                  <div>
                    <div
                      className={cn(
                        "flex items-center gap-2.5 rounded-md border px-3 py-2 text-xs",
                        hasPoint ? "border-steel-700/40 bg-steel-900/60" : "border-amber-500/40 bg-amber-500/10"
                      )}
                    >
                      {hasPoint
                        ? <CheckCircle2 className="h-4 w-4 shrink-0 text-olive-400" />
                        : <MapPin className="h-4 w-4 shrink-0 text-amber-300" />}
                      <span className="min-w-0 flex-1">
                        {hasPoint ? (
                          <>
                            <span className="block text-steel-200">Location set</span>
                            <span className="block font-mono text-[11px] text-steel-400">{lat.toFixed(6)}, {lng.toFixed(6)}</span>
                          </>
                        ) : (
                          <>
                            <span className="block text-amber-200">Location not set yet</span>
                            <span className="block text-[11px] text-steel-400">Search for the place or click the map.</span>
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => setTypeCoords((v) => !v)}
                        aria-expanded={typeCoords}
                        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-olive-300 hover:bg-steel-800 hover:text-olive-200"
                      >
                        {typeCoords ? "Hide coordinates" : "Enter coordinates"}
                      </button>
                    </div>

                    {typeCoords && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor="zone-lat" className="text-xs text-steel-400 mb-1 block">Latitude</label>
                          <input id="zone-lat" className="input-field w-full" type="number" step="any" min={-90} max={90} placeholder="8.4542"
                                 value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} />
                        </div>
                        <div>
                          <label htmlFor="zone-lng" className="text-xs text-steel-400 mb-1 block">Longitude</label>
                          <input id="zone-lng" className="input-field w-full" type="number" step="any" min={-180} max={180} placeholder="124.6319"
                                 value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} />
                        </div>
                        <p className="col-span-2 text-[11px] text-steel-500">
                          For a reading from a GPS device or Google Maps (decimal degrees).
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: where the zone is, found on the map rather than typed in */}
                <div className="space-y-3">
                  <p className="text-[10px] uppercase tracking-widest text-olive-300">Location</p>
                  <GeofencePicker
                    latitude={hasPoint ? lat : null}
                    longitude={hasPoint ? lng : null}
                    radius={form.radius_meters}
                    onChange={(la, ln) => setForm((f) => ({ ...f, latitude: la.toFixed(7), longitude: ln.toFixed(7) }))}
                    mapClassName="h-[300px] lg:h-[416px]"
                    otherZones={(locations ?? [])
                      .filter((l) => l.location_id !== editing?.location_id)
                      .map((l) => ({
                        id: l.location_id,
                        name: l.location_name,
                        lat: Number(l.center_latitude),
                        lng: Number(l.center_longitude),
                        radius: l.radius_meters,
                      }))}
                  />
                </div>
              </div>

              <div className="mt-5 flex gap-2 justify-end">
                <button type="button" onClick={resetForm} className="btn-secondary text-xs">Cancel</button>
                <button
                  disabled={save.isPending || !hasPoint}
                  title={hasPoint ? undefined : "Set the zone's location first"}
                  className="btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editing ? "Update" : "Create"} Geofence
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      <div className="glass rounded-xl p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-olive-300">
              <th className="text-left py-2">Zone Name</th>
              <th className="text-center">Coordinates</th>
              <th className="text-center">Radius</th>
              <th className="text-center">Type</th>
              <th className="text-center">Description</th>
              {canManage && <th className="text-center">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {isError && (
              <tr><td colSpan={6} className="py-0"><DataError onRetry={refetch} /></td></tr>
            )}
            {isLoading && !isError && (
              <tr><td colSpan={6} className="text-center py-6 text-steel-400">Loading…</td></tr>
            )}
            {locations?.map((loc) => (
              <tr key={loc.location_id} className="border-t border-steel-800 hover:bg-steel-800/30">
                <td className="py-2 text-olive-100 font-semibold">{loc.location_name}</td>
                <td className="text-center font-mono text-xs text-steel-300">
                  {Number(loc.center_latitude).toFixed(6)}, {Number(loc.center_longitude).toFixed(6)}
                </td>
                <td className="text-center text-steel-200">{loc.radius_meters}m</td>
                <td className="text-center">
                  <span className={`pill ${loc.is_armory || loc.is_camp ? "pill-tactical" : "pill-muted"}`}>
                    {ZONE_TYPES.find((t) => t.value === zoneType(loc))?.label}
                  </span>
                </td>
                <td className="text-center text-xs text-steel-400 max-w-xs truncate">{loc.description ?? "—"}</td>
                {canManage && (
                  <td className="text-center">
                    <div className="flex justify-center gap-1">
                      <button onClick={() => startEdit(loc)} className="btn-ghost text-xs">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(loc)}
                        className="btn-ghost text-xs text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {!isLoading && locations?.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-steel-500">No geofences defined yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <PasswordConfirmModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={(password) => remove.mutateAsync({ id: deleteTarget!.location_id, password })}
        title="Delete Geofence"
        description={`Delete "${deleteTarget?.location_name}"? This cannot be undone.`}
        confirmLabel="Delete"
      />
    </div>
  );
}

type ZoneType = "destination" | "camp" | "armory";

const ZONE_TYPES: { value: ZoneType; label: string; hint: string }[] = [
  { value: "destination", label: "Destination", hint: "A place firearms are sent to. It can be chosen as the destination when issuing a firearm." },
  { value: "camp", label: "Camp", hint: "Part of the camp. Issued firearms leave from and return to it; it is not offered as a destination." },
  { value: "armory", label: "Armory", hint: "Where firearms are stored. It counts as part of the camp and is not offered as a destination." },
];

/** Radii for the usual kinds of place. */
const SIZE_PRESETS = [
  { label: "Building", radius: 50 },
  { label: "Compound", radius: 150 },
  { label: "Camp", radius: 500 },
  { label: "Wide area", radius: 1000 },
];

/** "1 km across" for a 500 m radius. */
function acrossText(radius: number) {
  const across = radius * 2;
  return `${across >= 1000 ? `${Number((across / 1000).toFixed(1))} km` : `${across} m`} across`;
}

/** How much − and + change the radius: finer steps for small zones. */
function radiusStep(radius: number) {
  return radius < 100 ? 10 : radius < 1000 ? 50 : 100;
}

function zoneType(z: { is_armory: boolean; is_camp: boolean }): ZoneType {
  return z.is_armory ? "armory" : z.is_camp ? "camp" : "destination";
}

function TypeOption({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`w-full h-[42px] px-3 rounded-md border text-sm font-medium transition-colors duration-200 flex items-center justify-center gap-2 ${
        on
          ? "bg-olive-600/30 border-olive-500 text-olive-100"
          : "bg-steel-900/60 border-steel-700/40 text-steel-400 hover:border-steel-600"
      }`}
    >
      <span className={`h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
        on ? "border-olive-400" : "border-steel-500"
      }`}>
        {on && <span className="h-2 w-2 rounded-full bg-olive-400" />}
      </span>
      {label}
    </button>
  );
}
