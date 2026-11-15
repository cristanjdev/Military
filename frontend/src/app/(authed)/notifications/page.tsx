"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban, BatteryLow, BatteryWarning, Bell, BellOff, CheckCheck, ClipboardCheck, Clock, Flag, Info, KeyRound, Lock,
  LogIn, LogOut, MapPin, Navigation, Radio, Route, ShieldAlert, ShieldCheck, UserCog, Wifi, WifiOff, Wrench,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtDate } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";

interface NotificationItem {
  notification_id: number;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  status: "Unread" | "Read" | "Acknowledged";
  created_at: string;
  firearm?: { equipment_id: number; serial_number: string; model?: string | null } | null;
}

const TYPE_LABELS: Record<string, string> = {
  failed_login: "Failed sign-in",
  new_login: "New sign-in",
  account_change: "Account changed",
  account_locked: "Account locked",
  password_reset: "Password reset",
  unauthorized_access: "Access denied",
  geofence_violation: "Geofence breach",
  geofence_return: "Back in zone",
  signal_lost: "Signal lost",
  signal_restored: "Signal restored",
  iot_device_online: "Tracker online",
  battery_low: "Low battery",
  battery_critical: "Battery critical",
  trip_left_camp: "Left camp",
  trip_arrived: "Arrived",
  trip_left_destination: "Left destination",
  trip_returned: "Returned to camp",
  premature_departure: "Early departure",
  off_route: "Off route",
  camp_exit_after_return: "Left camp after return",
  overdue_return: "Overdue return",
  repair_reported: "Reported for repair",
  repair_forwarded: "Repair needs approval",
  repair_approved: "Repair approved",
  repair_rejected: "Repair rejected",
  repair_cleared: "Repair cleared",
  repair_sent: "Sent for repair",
  repair_returned: "Back from repair",
  maintenance_due: "Maintenance due",
  request_submitted: "New request",
  request_approved: "Request approved",
  request_rejected: "Request rejected",
};

const TYPE_ICONS: Record<string, LucideIcon> = {
  failed_login: ShieldAlert,
  new_login: LogIn,
  account_change: UserCog,
  account_locked: Lock,
  password_reset: KeyRound,
  unauthorized_access: Ban,
  geofence_violation: ShieldAlert,
  geofence_return: ShieldCheck,
  signal_lost: WifiOff,
  signal_restored: Wifi,
  iot_device_online: Radio,
  battery_low: BatteryLow,
  battery_critical: BatteryWarning,
  trip_left_camp: LogOut,
  trip_arrived: Flag,
  trip_left_destination: Navigation,
  trip_returned: MapPin,
  premature_departure: Clock,
  off_route: Route,
  camp_exit_after_return: LogOut,
  overdue_return: Clock,
  maintenance_due: Wrench,
};

/** Categories for the filter tabs. */
const GROUPS: { key: string; label: string; types?: string[] }[] = [
  { key: "all", label: "All" },
  { key: "account", label: "Sign-ins & Account", types: ["failed_login", "new_login", "account_change", "account_locked", "password_reset", "unauthorized_access"] },
  { key: "tracker", label: "GPS & Tracker", types: ["signal_lost", "signal_restored", "iot_device_online", "geofence_violation", "geofence_return", "battery_low", "battery_critical"] },
  { key: "trip", label: "Trips & Returns", types: ["trip_left_camp", "trip_arrived", "trip_left_destination", "trip_returned", "premature_departure", "off_route", "camp_exit_after_return", "overdue_return"] },
  { key: "repair", label: "Repairs & Requests", types: ["repair_reported", "repair_forwarded", "repair_approved", "repair_rejected", "repair_cleared", "repair_sent", "repair_returned", "maintenance_due", "request_submitted", "request_approved", "request_rejected"] },
];

const typeLabel = (type: string) => TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function iconFor(type: string): LucideIcon {
  if (TYPE_ICONS[type]) return TYPE_ICONS[type];
  if (type.startsWith("repair")) return Wrench;
  if (type.startsWith("request")) return ClipboardCheck;
  return Info;
}

const TONE = {
  critical: { icon: "text-red-400", label: "Critical", pill: "bg-red-500/15 text-red-300 border-red-500/30" },
  warning: { icon: "text-amber-400", label: "Warning", pill: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  info: { icon: "text-olive-300", label: "Info", pill: "" },
} as const;

/** "Today", "Yesterday", then "Thursday, November 12, 2026". */
function dayHeading(d: Date): string {
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return fmtDate(d, "EEEE, MMMM d, yyyy");
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [group, setGroup] = useState("all");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["notifications-page"],
    queryFn: async () => (await api.get<{ data: NotificationItem[] }>("/notifications", { params: { per_page: 100 } })).data,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["notifications-page"] });
    qc.invalidateQueries({ queryKey: ["unread-notifications"] });
  };

  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/mark-all-read"),
    onSuccess: () => { toast.success("All notifications marked as read."); refresh(); },
    onError: () => toast.error("Could not mark the notifications as read."),
  });

  const markOne = useMutation({
    mutationFn: (id: number) => api.patch(`/notifications/${id}/read`),
    onSuccess: refresh,
    onError: () => toast.error("Could not mark the notification as read."),
  });

  const all = data?.data ?? [];
  const unreadCount = all.filter((n) => n.status === "Unread").length;
  const inGroup = (n: NotificationItem, key: string) => {
    const types = GROUPS.find((g) => g.key === key)?.types;
    return !types || types.includes(n.type);
  };
  const visible = all.filter((n) => inGroup(n, group) && (!unreadOnly || n.status === "Unread"));

  // Newest first, under a heading per day.
  const days: { heading: string; items: NotificationItem[] }[] = [];
  for (const n of visible) {
    const heading = dayHeading(new Date(n.created_at));
    const last = days[days.length - 1];
    if (last?.heading === heading) last.items.push(n);
    else days.push({ heading, items: [n] });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2">
            <Bell className="h-5 w-5 text-olive-300" /> Notifications
          </h1>
          <p className="text-sm text-steel-400">
            Alerts about sign-ins, trackers, trips, repairs and requests.
            {unreadCount > 0 && <> You have <span className="font-semibold text-olive-100">{unreadCount} unread</span>.</>}
          </p>
        </div>
        <button
          onClick={() => markAll.mutate()}
          disabled={unreadCount === 0 || markAll.isPending}
          className="btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <CheckCheck className="h-4 w-4" /> Mark all as read
        </button>
      </div>

      {/* Category tabs with counts, and an unread-only switch */}
      <div className="flex flex-col gap-2 border-b border-steel-800 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Notification categories">
          {GROUPS.map((g) => {
            const count = all.filter((n) => inGroup(n, g.key) && (!unreadOnly || n.status === "Unread")).length;
            return (
              <button
                key={g.key}
                type="button"
                role="tab"
                aria-selected={group === g.key}
                onClick={() => setGroup(g.key)}
                className={cn(
                  "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition",
                  group === g.key ? "border-olive-400 text-olive-50" : "border-transparent text-steel-400 hover:text-steel-200"
                )}
              >
                {g.label}
                <span className="rounded-full bg-steel-800 px-1.5 py-px text-[10px] font-semibold text-steel-400">{count}</span>
              </button>
            );
          })}
        </div>
        {/* Switch styled to match the theme, instead of the browser's white checkbox */}
        <button
          type="button"
          role="switch"
          aria-checked={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
          className="mb-2 inline-flex items-center gap-2.5 self-start rounded-md px-1 py-1 text-xs text-steel-300 hover:text-steel-100 select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-olive-500/60 sm:self-auto"
        >
          <span
            className={cn(
              "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors",
              unreadOnly ? "border-olive-400/70 bg-olive-600" : "border-steel-700 bg-steel-800"
            )}
          >
            <span
              className={cn(
                "absolute left-0.5 h-3 w-3 rounded-full shadow transition-transform",
                unreadOnly ? "translate-x-[14px] bg-olive-50" : "translate-x-0 bg-steel-400"
              )}
            />
          </span>
          Unread only
        </button>
      </div>

      {isError && <DataError onRetry={refetch} />}
      {isLoading && !isError && <p className="text-sm text-steel-400">Loading…</p>}

      {!isLoading && !isError && visible.length === 0 && (
        <div className="glass rounded-xl p-10 text-center">
          <BellOff className="mx-auto mb-3 h-6 w-6 text-steel-500" />
          <p className="text-sm text-steel-300">{unreadOnly ? "No unread notifications." : "No notifications here."}</p>
          <p className="mt-1 text-xs text-steel-500">New alerts appear here and on the bell at the top.</p>
        </div>
      )}

      <div className="space-y-6">
        {days.map((day) => (
          <section key={day.heading}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-steel-500">{day.heading}</h2>
            <ul className="glass rounded-xl divide-y divide-steel-800/70 overflow-hidden">
              {day.items.map((n) => {
                const Icon = iconFor(n.type);
                const tone = TONE[n.severity] ?? TONE.info;
                const unread = n.status === "Unread";
                return (
                  <li
                    key={n.notification_id}
                    className={cn("group px-4 py-3.5 sm:px-5", unread && "bg-olive-950/20")}
                  >
                    {/* Row 1: icon, title and severity; time and unread dot on the right */}
                    <div className="flex items-center gap-2.5">
                      <Icon className={cn("h-4 w-4 shrink-0", tone.icon)} aria-hidden />
                      <p className={cn("min-w-0 truncate text-sm", unread ? "font-semibold text-olive-50" : "font-medium text-steel-200")} title={n.title}>
                        {n.title}
                      </p>
                      {n.severity !== "info" && (
                        <span className={cn("shrink-0 rounded border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider", tone.pill)}>
                          {tone.label}
                        </span>
                      )}
                      {/* The dot's space stays when read, so the times line up */}
                      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                        <time
                          dateTime={n.created_at}
                          title={fmtDate(n.created_at, "MMMM d, yyyy 'at' h:mm a")}
                          className="whitespace-nowrap text-[11px] text-steel-500"
                        >
                          {fmtDate(n.created_at, "h:mm a")}
                        </time>
                        <span
                          className={cn("h-2 w-2 rounded-full", unread ? "bg-olive-400" : "bg-transparent")}
                          aria-label={unread ? "Unread" : undefined}
                        />
                      </span>
                    </div>

                    {/* Message, full width from the left edge */}
                    <p className="mt-1.5 text-xs leading-relaxed text-steel-300 break-words">{n.message}</p>

                    {/* Category and firearm; "Mark as read" on the right */}
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-steel-500">
                      <span>{typeLabel(n.type)}</span>
                      {n.firearm && (
                        <>
                          <span className="text-steel-700">·</span>
                          <Link
                            href={`/firearms/${n.firearm.equipment_id}`}
                            className="font-mono text-olive-300 hover:text-olive-200 hover:underline"
                          >
                            {n.firearm.serial_number}
                          </Link>
                        </>
                      )}
                      {unread && (
                        <button
                          type="button"
                          onClick={() => markOne.mutate(n.notification_id)}
                          disabled={markOne.isPending}
                          className="ml-auto shrink-0 text-olive-300 hover:text-olive-100 hover:underline transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                          Mark as read
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
