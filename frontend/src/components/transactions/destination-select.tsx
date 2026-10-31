"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface Zone {
  location_id: number;
  location_name: string;
  is_armory: boolean;
  is_camp?: boolean;
}

/** The zones a firearm can be sent to: every geofence that is not part of the camp. */
export function DestinationSelect({
  id,
  value,
  onChange,
  disabled,
  className = "input-field w-full",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const zonesQuery = useQuery({
    queryKey: ["locations"],
    queryFn: async () => (await api.get<Zone[]>("/locations")).data,
  });
  const destinations = (zonesQuery.data ?? []).filter((z) => !z.is_camp && !z.is_armory);

  return (
    <>
      <select
        id={id}
        className={className}
        required
        disabled={disabled || zonesQuery.isLoading}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{zonesQuery.isLoading ? "Loading zones…" : "— Select destination —"}</option>
        {destinations.map((zone) => (
          <option key={zone.location_id} value={zone.location_id}>{zone.location_name}</option>
        ))}
      </select>
      {zonesQuery.isError && <p className="mt-1 text-xs text-red-300">Zones could not be loaded.</p>}
      {zonesQuery.isSuccess && destinations.length === 0 && (
        <p className="mt-1 text-xs text-amber-300">No destination zones yet. Add one on the Geofences page.</p>
      )}
    </>
  );
}
