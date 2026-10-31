"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/utils";
import { CheckCheck, BellRing } from "lucide-react";
import { toast } from "sonner";
import { DataError } from "@/components/ui/data-error";

const TYPE_LABELS: Record<string, string> = {
  failed_login: "Failed Sign-in",
  new_login: "New Sign-in",
  account_change: "Account Changed",
  account_locked: "Account Locked",
  password_reset: "Password Reset",
  geofence_violation: "Geofence Breach",
  geofence_return: "Back in Zone",
  signal_lost: "Signal Lost",
  signal_restored: "Signal Restored",
  iot_device_online: "Tracker Online",
  trip_left_camp: "Left Camp",
  trip_arrived: "Arrived at Destination",
  trip_left_destination: "Left Destination",
  trip_returned: "Returned to Camp",
  premature_departure: "Premature Departure",
  off_route: "Off-Route",
  camp_exit_after_return: "Left Camp After Return",
  battery_low: "Low Battery",
  battery_critical: "Battery Critical",
};

/** Filter groups for the client's notification categories. */
const GROUPS: { key: string; label: string; types?: string[] }[] = [
  { key: "all", label: "All" },
  { key: "account", label: "Sign-ins & Account", types: ["failed_login", "new_login", "account_change", "account_locked", "password_reset"] },
  { key: "tracker", label: "GPS & IoT Tracker", types: ["signal_lost", "signal_restored", "iot_device_online", "geofence_violation", "geofence_return", "battery_low", "battery_critical"] },
  { key: "trip", label: "Trips & Destinations", types: ["trip_left_camp", "trip_arrived", "trip_left_destination", "trip_returned", "premature_departure", "off_route", "camp_exit_after_return"] },
];

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [group, setGroup] = useState("all");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["notifications-page"],
    queryFn: async () => (await api.get("/notifications", { params: { per_page: 100 } })).data,
  });

  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/mark-all-read"),
    onSuccess: () => {
      toast.success("All marked as read.");
      qc.invalidateQueries({ queryKey: ["notifications-page"] });
      qc.invalidateQueries({ queryKey: ["unread-notifications"] });
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2"><BellRing className="h-5 w-5 text-olive-300" /> Notifications</h1>
        </div>
        <button onClick={() => markAll.mutate()} className="btn-secondary text-xs">
          <CheckCheck className="h-4 w-4" /> Mark all read
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Notification categories">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setGroup(g.key)}
            aria-pressed={group === g.key}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
              group === g.key ? "border-olive-400/70 bg-olive-700/35 text-olive-50" : "border-steel-700/70 bg-steel-900/50 text-steel-300 hover:text-olive-100"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {isError && <DataError onRetry={refetch} />}
        {isLoading && !isError && <p className="text-steel-300">Loading…</p>}
        {data?.data?.length === 0 && <p className="text-steel-400">No notifications.</p>}
        {data?.data?.filter((n: any) => { const types = GROUPS.find((g) => g.key === group)?.types; return !types || types.includes(n.type); }).map((n: any) => (
          <div key={n.notification_id} className={`glass rounded-md p-3 flex gap-3 border-l-4 ${
            n.severity === "critical" ? "border-red-500" : n.severity === "warning" ? "border-amber-500" : "border-blue-500"
          }`}>
            <div className="flex-1">
              <div className="flex justify-between gap-2">
                <p className="text-sm font-semibold text-olive-100">{n.title}</p>
                <span className="text-[10px] text-steel-500">{fmtRelative(n.created_at)}</span>
              </div>
              <p className="text-xs text-steel-300 mt-0.5">{n.message}</p>
              <div className="flex gap-2 mt-2">
                <span className={`pill pill-${n.severity === "critical" ? "critical" : n.severity === "warning" ? "warn" : "info"}`}>{n.severity.toUpperCase()}</span>
                <span className="pill pill-muted">{typeLabel(n.type)}</span>
                {n.firearm && <span className="pill pill-tactical">{n.firearm.serial_number}</span>}
              </div>
            </div>
            {n.status === "Unread" && <span className="h-2 w-2 mt-2 rounded-full bg-olive-400 animate-pulse" />}
          </div>
        ))}
      </div>
    </div>
  );
}
