"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Crosshair, LocateFixed, MapPin, Navigation, Search, SignalZero, X } from "lucide-react";
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

interface Zone {
  location_id: number;
  location_name: string;
  radius_meters: number;
  is_armory: boolean;
  is_camp: boolean;
}

interface LiveResponse {
  items: LiveItem[];
  geofences: Zone[];
}

/**
 * Map of the authorized zones beside a list of every firearm that is out. Each firearm is listed
 * once: those needing attention first, then those on the way, then by the innermost zone they are
 * in. A firearm on its way to or from its destination is between zones, which is normal.
 */
export function ZoneOccupancy() {
  const [focusId, setFocusId] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState("");
  const mapRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["gps-live"],
    queryFn: async () => (await api.get<LiveResponse>("/gps/live")).data,
    refetchInterval: 30_000,
  });

  const items = data?.items ?? [];
  const zones = data?.geofences ?? [];

  // A firearm whose tracker has not sent a position yet is drawn at its assigned zone's centre,
  // which says nothing about where it really is, so it gets its own group.
  const noPosition = items.filter((i) => i.telemetry_source === "placeholder");
  const tracked = items.filter((i) => i.telemetry_source !== "placeholder");
  const attention = tracked.filter((i) => i.needs_attention ?? (i.zones?.length ?? 0) === 0);
  const onTheWay = tracked.filter((i) => !attention.includes(i) && (i.zones?.length ?? 0) === 0);
  const inZone = tracked.filter((i) => !attention.includes(i) && (i.zones?.length ?? 0) > 0);

  // Zones overlap (the armory sits inside the camp), so list each firearm under the smallest one.
  const innermost = (i: LiveItem) =>
    zones
      .filter((z) => i.zones?.includes(z.location_name))
      .sort((a, b) => a.radius_meters - b.radius_meters)[0]?.location_name ?? i.zones?.[0];
  const byZone = zones.map((z) => ({ zone: z, firearms: inZone.filter((i) => innermost(i) === z.location_name) }));
  const occupied = byZone.filter((g) => g.firearms.length > 0);
  const empty = byZone.filter((g) => g.firearms.length === 0);

  // Search by serial number, model or the person who has it.
  const term = query.trim().toLowerCase();
  const show = (list: LiveItem[]) =>
    term ? list.filter((i) => [i.serial_number, i.model, i.assigned_to ?? ""].some((v) => v.toLowerCase().includes(term))) : list;
  const shownAttention = show(attention);
  const shownOnTheWay = show(onTheWay);
  const shownZones = occupied.map((g) => ({ ...g, firearms: show(g.firearms) })).filter((g) => g.firearms.length > 0);
  const shownNoPosition = show(noPosition);
  const nothingFound =
    term !== "" && shownAttention.length + shownOnTheWay.length + shownZones.length + shownNoPosition.length === 0;

  const focused = items.find((i) => i.equipment_id === focusId);

  /** Select a firearm (again to go back to all). On a phone the map is above the list, so scroll up to it. */
  const select = (id: number) => {
    const next = focusId === id ? undefined : id;
    setFocusId(next);
    if (next != null && window.innerWidth < 1024) mapRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /** The tiles jump to their group in the list. */
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const row = (i: LiveItem, note?: string, danger = false) => (
    <li key={i.equipment_id}>
      <FirearmRow item={i} note={note} danger={danger} active={focusId === i.equipment_id} onClick={() => select(i.equipment_id)} />
    </li>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <div ref={mapRef} className="glass relative h-[24rem] sm:h-[30rem] scroll-mt-4 overflow-hidden rounded-xl p-2 lg:col-span-8">
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

      <section className="glass flex flex-col overflow-hidden rounded-xl lg:col-span-4 lg:h-[30rem]">
        <header className="px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="section-title flex items-center gap-2">
              <Crosshair className="h-4 w-4" /> Firearms Out
            </p>
            <span className="rounded-full bg-steel-800 px-2 py-0.5 text-[11px] font-semibold text-steel-300">{items.length}</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat
              label="Needs attention"
              value={attention.length}
              tone={attention.length > 0 ? "danger" : "muted"}
              onClick={attention.length > 0 ? () => jumpTo("occ-attention") : undefined}
            />
            <Stat label="On the way" value={onTheWay.length} onClick={onTheWay.length > 0 ? () => jumpTo("occ-on-the-way") : undefined} />
            <Stat label="In a zone" value={inZone.length} onClick={inZone.length > 0 ? () => jumpTo("occ-zones") : undefined} />
          </div>

          {items.length > 5 && (
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-steel-500" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find by serial, model or name"
                aria-label="Find a firearm"
                className="input-field w-full py-1.5 pl-8 pr-8 text-xs"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-steel-400 hover:text-steel-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          <p className="mt-2.5 truncate text-[11px] text-steel-400">
            {focused
              ? <>Showing <span className="font-mono text-olive-200">{focused.serial_number}</span> on the map. Select it again to show all.</>
              : "Select a firearm to show it on the map."}
          </p>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4 pt-1">
          {isLoading && <p className="py-6 text-center text-sm text-steel-400">Loading…</p>}

          {!isLoading && items.length === 0 && (
            <p className="flex items-center gap-2 py-6 text-sm text-steel-400">
              <LocateFixed className="h-4 w-4 shrink-0" /> No firearms are out right now.
            </p>
          )}

          {nothingFound && (
            <p className="py-6 text-center text-sm text-steel-400">No firearm matches &ldquo;{query.trim()}&rdquo;.</p>
          )}

          {shownAttention.length > 0 && (
            <Group id="occ-attention" icon={AlertTriangle} title="Needs attention" count={shownAttention.length} danger>
              {shownAttention.map((i) => row(i, i.zones?.length ? `In ${i.zones.join(", ")}` : "Outside every zone", true))}
            </Group>
          )}

          {shownOnTheWay.length > 0 && (
            <Group id="occ-on-the-way" icon={Navigation} title="On the way" count={shownOnTheWay.length}>
              {shownOnTheWay.map((i) => row(i, i.destination ? `Going to ${i.destination}` : undefined))}
            </Group>
          )}

          {shownZones.map(({ zone, firearms }, n) => (
            <Group
              key={zone.location_id}
              id={n === 0 ? "occ-zones" : undefined}
              icon={MapPin}
              title={zone.location_name}
              sub={zoneLabel(zone)}
              count={firearms.length}
            >
              {firearms.map((i) => row(i))}
            </Group>
          ))}

          {shownNoPosition.length > 0 && (
            <Group icon={SignalZero} title="No position yet" count={shownNoPosition.length}>
              {shownNoPosition.map((i) => row(i, "The tracker has not sent a position"))}
            </Group>
          )}

          {!term && items.length > 0 && empty.length > 0 && (
            <p className="text-[11px] leading-relaxed text-steel-500">
              <span className="text-steel-400">No firearms in:</span> {empty.map((g) => g.zone.location_name).join(", ")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function zoneLabel(z: Zone) {
  return z.is_armory ? "Armory" : z.is_camp ? "Camp" : "Destination";
}

function Stat({
  label,
  value,
  tone = "default",
  onClick,
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "muted";
  /** Jumps to the matching group; left out when there is nothing to jump to. */
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={onClick ? `Go to ${label.toLowerCase()}` : undefined}
      className={cn(
        "rounded-lg border px-2.5 py-2 text-left transition disabled:cursor-default",
        tone === "danger"
          ? "border-red-600/50 bg-red-900/20 enabled:hover:bg-red-900/30"
          : "border-steel-800 bg-steel-900/40 enabled:hover:border-olive-600/50"
      )}
    >
      <span className={cn("block text-lg font-semibold leading-none", tone === "danger" ? "text-red-200" : tone === "muted" || value === 0 ? "text-steel-400" : "text-olive-50")}>
        {value}
      </span>
      <span className={cn("mt-1 block truncate text-[10px]", tone === "danger" ? "text-red-300" : "text-steel-400")}>{label}</span>
    </button>
  );
}

function Group({
  id,
  icon: Icon,
  title,
  sub,
  count,
  danger = false,
  children,
}: {
  id?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub?: string;
  count: number;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-2">
      <div className="mb-2 flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", danger ? "text-red-400" : "text-olive-400")} />
        <p className={cn("min-w-0 truncate text-xs font-semibold", danger ? "text-red-200" : "text-olive-100")}>{title}</p>
        {sub && <span className="shrink-0 text-[10px] text-steel-500">{sub}</span>}
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold",
            danger ? "bg-red-500/20 text-red-300" : "bg-steel-800 text-steel-400"
          )}
        >
          {count}
        </span>
      </div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

function FirearmRow({
  item: i,
  note,
  danger,
  active,
  onClick,
}: {
  item: LiveItem;
  note?: string;
  danger: boolean;
  active: boolean;
  onClick: () => void;
}) {
  // Worth a glance whichever group the firearm is in.
  const flag = i.status === "Overdue" ? "Overdue for return" : i.status === "Maintenance" ? "Out for repair" : null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
        active
          ? "border-olive-400/70 bg-olive-800/30"
          : danger
          ? "border-red-600/50 bg-red-900/20 hover:bg-red-900/30"
          : "border-steel-800 bg-steel-900/40 hover:border-olive-600/50"
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className={cn("shrink-0 font-mono text-[13px] font-semibold", danger ? "text-red-100" : "text-olive-100")}>{i.serial_number}</span>
          <span className="truncate text-[11px] text-steel-400">{i.model}</span>
        </p>
        <p className="truncate text-xs text-steel-300">{i.assigned_to ?? "Not assigned"}</p>
        {(note || flag) && (
          <p className="truncate text-[11px]">
            {flag && <span className="font-medium text-amber-300">{flag}</span>}
            {flag && note && <span className="text-steel-600"> · </span>}
            {note && <span className={danger ? "text-red-300" : "text-steel-400"}>{note}</span>}
          </p>
        )}
      </div>
      <Signal item={i} />
    </button>
  );
}

/** How fresh the position is: live, last seen some time ago, or nothing from the tracker yet. */
function Signal({ item: i }: { item: LiveItem }) {
  if (i.telemetry_source === "iot") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-emerald-300" title={i.captured_at ? `Position ${fmtRelative(i.captured_at)}` : undefined}>
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> Live
      </span>
    );
  }
  if (i.telemetry_source === "stale") {
    return (
      <span className="shrink-0 text-right text-[10px] leading-tight text-steel-400" title="The tracker is not reporting; this is its last position.">
        Last seen
        <span className="block text-steel-300">{i.captured_at ? fmtRelative(i.captured_at).replace(/^about /, "") : "—"}</span>
      </span>
    );
  }
  return <span className="shrink-0 text-[10px] text-steel-500">No signal</span>;
}
