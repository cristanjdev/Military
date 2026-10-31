"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, Flag, Loader2, Mail, MapPin, Phone, Radio, User, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtDate, fmtRelative } from "@/lib/utils";
import { destinationChangeable, TRIP_STAGE_LABEL, type TripStage } from "@/lib/trip";
import { useAuthStore, hasRole } from "@/store/auth";
import type { TransactionRow } from "./transaction-ledger";
import { DestinationSelect } from "./destination-select";

const LiveMap = dynamic(() => import("@/components/maps/live-map").then((m) => m.LiveMap), { ssr: false });

interface LivePosition {
  equipment_id: number;
  lat: number;
  lon: number;
  captured_at?: string | null;
  inside_geofence?: boolean | null;
  destination?: string | null;
  trip_stage?: TripStage | null;
  hold_until?: string | null;
  needs_attention?: boolean;
  telemetry_source: "iot" | "stale" | "placeholder" | "missing";
  location_note: string;
}

function overdueFor(expected: string): string | null {
  const ms = Date.now() - new Date(expected).getTime();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (hours < 48) return `${hours} hr`;
  return `${Math.floor(hours / 24)} days`;
}

const SOURCE_LABEL: Record<LivePosition["telemetry_source"], { text: string; tone: string }> = {
  iot:         { text: "Live tracker",        tone: "text-emerald-300" },
  stale:       { text: "Last known position", tone: "text-amber-300" },
  placeholder: { text: "No GPS fix yet; showing assigned zone", tone: "text-steel-300" },
  missing:     { text: "No position",         tone: "text-red-300" },
};

/**
 * Where is this firearm right now, and who has it? Opened from the GPS tag on an open transaction.
 */
export function LocateFirearmModal({ transaction, onClose }: { transaction: TransactionRow; onClose: () => void }) {
  // Same cache key as the live map, so both share one poll.
  const { data, isLoading } = useQuery({
    queryKey: ["gps-live"],
    queryFn: async () => (await api.get<{ items: LivePosition[] }>("/gps/live")).data,
    refetchInterval: 30_000,
  });

  const position = data?.items.find((i) => i.equipment_id === transaction.equipment_id);
  const person = transaction.user;
  const overdue = transaction.status === "Overdue" ? overdueFor(transaction.expected_return_at) : null;
  const source = position ? SOURCE_LABEL[position.telemetry_source] : null;

  // The destination: set at issuance; the Custodian and the roles above it may change it until arrival.
  const qc = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const [editingDestination, setEditingDestination] = useState(false);
  const [newDestination, setNewDestination] = useState("");
  const destination = position?.destination ?? transaction.destination?.location_name ?? null;
  const stage = position?.trip_stage ?? transaction.trip_stage ?? null;
  const canChangeDestination = hasRole(user, "Administrator", "Command Officer", "Armory Custodian")
    && destinationChangeable(destination ? stage : null);
  const changeDestination = useMutation({
    mutationFn: async () => api.patch(`/transactions/${transaction.transaction_id}/destination`, {
      destination_location_id: Number(newDestination),
    }),
    onSuccess: () => {
      toast.success("Destination changed.");
      setEditingDestination(false);
      qc.invalidateQueries({ queryKey: ["gps-live"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? "The destination could not be changed."),
  });

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass w-full max-w-5xl rounded-xl p-4 max-h-[calc(100dvh-1.5rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Location of ${transaction.firearm?.serial_number ?? "firearm"}`}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="section-title flex items-center gap-2">
              <MapPin className="h-4 w-4" /> Locate Firearm
            </p>
            <p className="mt-1 font-mono text-sm text-olive-100">
              {transaction.firearm?.serial_number ?? "—"}
              {transaction.firearm?.model && <span className="text-steel-400"> ({transaction.firearm.model})</span>}
              <span className="text-steel-500"> · Transaction #{transaction.transaction_id}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="relative h-[22rem] sm:h-[28rem] overflow-hidden rounded-lg border border-steel-800">
            {position ? (
              <LiveMap focusId={transaction.equipment_id} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6 text-steel-400 text-sm">
                {isLoading ? "Loading position…" : (
                  <>
                    <AlertTriangle className="h-6 w-6 text-amber-400" />
                    No GPS position has been received for this firearm yet.
                  </>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3 text-sm">
            {overdue && (
              <div className="rounded-lg border border-red-700/50 bg-red-900/20 px-3 py-2 text-red-200">
                <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Overdue by {overdue}</p>
                <p className="text-xs text-red-200/80 mt-0.5">Expected back {fmtDate(transaction.expected_return_at)}</p>
              </div>
            )}

            <div className="rounded-lg border border-steel-800 bg-steel-900/40 p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-olive-300">Checked out by</p>
              <p className="font-semibold text-olive-50 flex items-center gap-1.5">
                <User className="h-4 w-4 text-olive-300" />
                {person ? `${person.rank ? `${person.rank} ` : ""}${person.first_name} ${person.last_name}` : "Unknown"}
              </p>
              {person?.username && <p className="text-xs text-steel-400">@{person.username}</p>}
              {person?.phone && (
                <a href={`tel:${person.phone}`} className="flex items-center gap-1.5 text-xs text-olive-200 hover:text-olive-100">
                  <Phone className="h-3.5 w-3.5" /> {person.phone}
                </a>
              )}
              {person?.email && (
                <a href={`mailto:${person.email}`} className="flex items-center gap-1.5 text-xs text-olive-200 hover:text-olive-100 break-all">
                  <Mail className="h-3.5 w-3.5 shrink-0" /> {person.email}
                </a>
              )}
              <p className="flex items-center gap-1.5 text-xs text-steel-400">
                <Clock className="h-3.5 w-3.5" /> Checked out {fmtDate(transaction.checkout_at)}
              </p>
            </div>

            <div className="rounded-lg border border-steel-800 bg-steel-900/40 p-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-widest text-olive-300">Position</p>
              {position ? (
                <>
                  <p className={cn("flex items-center gap-1.5 text-xs font-semibold", source?.tone)}>
                    <Radio className="h-3.5 w-3.5" /> {source?.text}
                  </p>
                  <p className="font-mono text-xs text-steel-200">
                    {Number(position.lat).toFixed(5)}, {Number(position.lon).toFixed(5)}
                  </p>
                  {position.captured_at && (
                    <p className="text-xs text-steel-400">Last fix {fmtRelative(position.captured_at)}</p>
                  )}
                  {(position.needs_attention ?? position.inside_geofence === false) && (
                    <p className="text-xs font-semibold text-red-300">
                      {position.destination ? "Off its route" : "Outside all authorized zones"}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-steel-400">{isLoading ? "Loading…" : "Unknown"}</p>
              )}
            </div>

            <div className="rounded-lg border border-steel-800 bg-steel-900/40 p-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-widest text-olive-300">Trip</p>
              {destination ? (
                <>
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-olive-50">
                    <Flag className="h-4 w-4 text-olive-300" /> {destination}
                  </p>
                  {stage && <p className="text-xs text-steel-300">{TRIP_STAGE_LABEL[stage]}</p>}
                  {stage === "on_site" && position?.hold_until && (
                    <p className="text-xs text-steel-400">Must stay until {fmtDate(position.hold_until)}</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-steel-400">No destination was set for this issuance.</p>
              )}
              {canChangeDestination && !editingDestination && (
                <button
                  type="button"
                  className="btn-ghost text-xs px-0"
                  onClick={() => { setNewDestination(""); setEditingDestination(true); }}
                >
                  {destination ? "Change destination" : "Set destination"}
                </button>
              )}
              {editingDestination && (
                <form
                  className="space-y-2 pt-1"
                  onSubmit={(e) => { e.preventDefault(); changeDestination.mutate(); }}
                >
                  <DestinationSelect
                    value={newDestination}
                    onChange={setNewDestination}
                    disabled={changeDestination.isPending}
                    className="input-field w-full text-xs"
                  />
                  <div className="flex gap-2">
                    <button type="submit" className="btn-primary text-xs" disabled={changeDestination.isPending || !newDestination}>
                      {changeDestination.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
                    </button>
                    <button type="button" className="btn-secondary text-xs" onClick={() => setEditingDestination(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>

            <Link href={`/firearms/${transaction.equipment_id}`} className="btn-secondary w-full justify-center text-xs">
              Firearm record
            </Link>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
