"use client";

import { Fragment, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CONDITIONS, STATUSES, fmtDate } from "@/lib/utils";
import { humanizeAuditAction } from "@/lib/audit";
import { Lock, ChevronLeft, ChevronRight, ChevronDown, ShieldCheck, ShieldX, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { DataError } from "@/components/ui/data-error";

const ROLES = ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian", "Personnel"];

interface VerifyResult {
  intact: boolean;
  checked: number;
  issue_count: number;
  last_log_id: number | null;
  last_logged_at: string | null;
  issues: { log_id: number; problem: string }[];
  verified_at: string;
}

type Change = { from: unknown; to: unknown };

/** Plain names for the fields the backend records (anything else is spelled out from its key). */
const FIELD_LABELS: Record<string, string> = {
  required_clearance: "Clearance needed",
  user_clearance: "Account's clearance",
  required_roles: "Allowed roles",
  transaction_id: "Issuance",
  recipient_id: "Issued to (user ID)",
  destination_location_id: "Destination (geofence ID)",
  target_user_id: "User ID",
  request_id: "Request",
  repair_id: "Repair",
  maintenance_id: "Maintenance record",
  location_id: "Geofence ID",
  device_id: "Tracker",
  source: "Verified with",
  result_status: "Result",
  from: "Before",
  to: "After",
  serial_number: "Serial number",
  condition_status: "Condition",
  availability_status: "Status",
  acquisition_cost: "Acquisition cost",
  estimated_cost: "Estimated cost",
  location_name: "Name",
  center_latitude: "Latitude",
  center_longitude: "Longitude",
  radius_meters: "Radius (m)",
  security_level: "Security level",
  is_armory: "Armory",
  is_camp: "Camp",
  user_id: "User ID",
  first_name: "First name",
  last_name: "Last name",
};

/** Record numbers shown as "#12". */
const NUMBERED = new Set(["transaction_id", "request_id", "repair_id", "maintenance_id"]);

function fieldLabel(key: string) {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function fieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "condition_status" && typeof value === "number") return CONDITIONS[value]?.label ?? String(value);
  if (key === "availability_status" && typeof value === "number") return STATUSES[value]?.label ?? String(value);
  if (key.endsWith("clearance")) return `Level ${value}`;
  if (NUMBERED.has(key)) return `#${value}`;
  if (key.endsWith("cost") && !Number.isNaN(Number(value))) return `₱${Number(value).toLocaleString()}`;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => fieldValue("", v)).join(", ");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return fmtDate(value, "MMMM d, yyyy 'at' h:mm a");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${fieldLabel(k)}: ${fieldValue(k, v)}`).join(" · ");
  }
  return String(value);
}

/** One sentence for the entries whose details are easier read as words. */
function auditSummary(m: Record<string, any>): { text: string; keys: string[] } | null {
  if (m.required_clearance != null) {
    return {
      text: `Blocked because this needs clearance level ${m.required_clearance} and the account has level ${m.user_clearance ?? "unknown"}.`,
      keys: ["required_clearance", "user_clearance"],
    };
  }
  if (Array.isArray(m.required_roles)) {
    return { text: `Blocked because only ${m.required_roles.join(", ")} can do this.`, keys: ["required_roles"] };
  }
  return null;
}

/** What an entry recorded beyond its one-line description, in words and named fields (never raw data). */
function AuditDetails({ metadata }: { metadata: Record<string, any> }) {
  const changes = metadata.changes as Record<string, Change> | undefined;
  const snapshot = (metadata.deleted ?? metadata.created) as Record<string, unknown> | undefined;
  const isChangeMap = !!changes && Object.values(changes).every((c) => c && typeof c === "object" && "from" in c);
  const summary = auditSummary(metadata);
  const hidden = new Set(["changes", "deleted", "created", ...(summary?.keys ?? [])]);
  const facts = Object.entries(metadata).filter(([k, v]) => !hidden.has(k) && v !== null && v !== undefined && v !== "");

  return (
    <div className="max-w-4xl space-y-4">
      {summary && (
        <p className="flex items-start gap-2 text-sm text-steel-100">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /> {summary.text}
        </p>
      )}

      {isChangeMap && (
        <DetailSection title="What changed">
          {Object.keys(changes!).length === 0 ? (
            <p className="text-xs text-steel-400">Saved with no field changes.</p>
          ) : (
            <dl className="space-y-1.5">
              {Object.entries(changes!).map(([field, c]) => (
                <div key={field} className="grid grid-cols-[10rem_minmax(0,1fr)] items-baseline gap-3">
                  <dt className="text-xs text-steel-400">{fieldLabel(field)}</dt>
                  <dd className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="text-steel-400 line-through decoration-steel-500">{fieldValue(field, c.from)}</span>
                    <span className="text-steel-500" aria-label="changed to">→</span>
                    <span className="text-steel-100">{fieldValue(field, c.to)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </DetailSection>
      )}

      {snapshot && (
        <DetailSection title={metadata.deleted ? "Record removed" : "Record added"}>
          <FactGrid entries={Object.entries(snapshot)} />
        </DetailSection>
      )}

      {facts.length > 0 && (
        isChangeMap || snapshot
          ? <DetailSection title="Details"><FactGrid entries={facts} /></DetailSection>
          : <FactGrid entries={facts} />
      )}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold text-steel-300">{title}</h4>
      {children}
    </section>
  );
}

function FactGrid({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] text-steel-400">{fieldLabel(k)}</dt>
          <dd className="break-words text-sm text-steel-100">{fieldValue(k, v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  const { data: actions } = useQuery({
    queryKey: ["audit-actions"],
    queryFn: async () => (await api.get<string[]>("/audit-logs/actions")).data,
  });

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["audit-logs", action, role, page],
    queryFn: async () => (await api.get("/audit-logs", { params: { action: action || undefined, role: role || undefined, page, per_page: 15 } })).data,
  });

  const verifyMutation = useMutation({
    mutationFn: async () => (await api.get<VerifyResult>("/audit-logs/verify")).data,
    onSuccess: (result) => {
      setVerify(result);
      refetch();
    },
    onError: () => toast.error("Could not verify the audit trail."),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2"><Lock className="h-5 w-5 text-olive-300" /> Audit Trail</h1>
          <p className="text-sm text-steel-400 max-w-3xl">
            Every privileged action, including the Command Officer&apos;s, with the values before and after each change.
            Entries cannot be edited or deleted by anyone, and each one is signed and chained to the one before it.
          </p>
        </div>
        <button onClick={() => verifyMutation.mutate()} disabled={verifyMutation.isPending} className="btn-secondary text-xs shrink-0">
          {verifyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Verify integrity
        </button>
      </div>

      {verify && (
        <div
          role="status"
          className={`rounded-xl border p-4 text-sm ${verify.intact ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-100" : "border-red-700/60 bg-red-900/25 text-red-100"}`}
        >
          <p className="font-semibold flex items-center gap-2">
            {verify.intact ? <ShieldCheck className="h-4 w-4" /> : <ShieldX className="h-4 w-4" />}
            {verify.intact
              ? `Intact: all ${verify.checked.toLocaleString()} entries checked. Nothing has been edited or deleted.`
              : `Tampering detected: ${verify.issue_count} problem(s) in ${verify.checked.toLocaleString()} entries.`}
          </p>
          <p className="mt-1 text-xs opacity-80">
            Checked {fmtDate(verify.verified_at)}{verify.last_log_id ? ` · newest entry #${verify.last_log_id} (${fmtDate(verify.last_logged_at)})` : ""}
          </p>
          {!verify.intact && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {verify.issues.map((i) => (
                <li key={`${i.log_id}-${i.problem}`}>Entry #{i.log_id}: {i.problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="glass rounded-xl p-4 flex flex-col min-h-[500px]">
        <div className="mb-3 flex flex-wrap gap-2">
          <select className="input-field max-w-xs" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
            <option value="">All actions</option>
            {actions?.map((a: string) => (
              <option key={a} value={a}>
                {humanizeAuditAction(a)}
              </option>
            ))}
          </select>
          <select className="input-field max-w-xs" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-olive-300">
                <th className="text-left py-2">Time</th>
                <th className="text-center">Actor</th>
                <th className="text-center">Role</th>
                <th className="text-center">Action</th>
                <th className="text-center px-3">Description</th>
                <th className="text-center">IP</th>
                <th className="text-center">Firearm</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {isError && <tr><td colSpan={8} className="py-0"><DataError error={error} onRetry={refetch} /></td></tr>}
              {isLoading && !isError && <tr><td colSpan={8} className="text-center py-8 text-steel-400">Loading…</td></tr>}
              {!isLoading && data?.data?.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-steel-500">No audit logs found.</td></tr>
              )}
              {data?.data?.map((row: any) => {
                const hasDetails = row.metadata && Object.keys(row.metadata).length > 0;
                const open = expanded === row.log_id;
                return (
                  <Fragment key={row.log_id}>
                    <tr
                      className={`border-t border-steel-800/50 hover:bg-steel-800/20 transition-colors ${hasDetails ? "cursor-pointer" : ""}`}
                      onClick={() => hasDetails && setExpanded(open ? null : row.log_id)}
                    >
                      <td className="text-xs text-steel-300 py-2.5 font-mono whitespace-nowrap">{fmtDate(row.created_at)}</td>
                      <td className="text-center text-olive-100 text-xs font-medium whitespace-nowrap">{row.user?.username ?? "system"}</td>
                      <td className="text-center text-xs text-steel-400 whitespace-nowrap">{row.role ?? "—"}</td>
                      <td className="text-center whitespace-nowrap">
                        <span className={`pill text-[10px] ${/delete|failed|breach|denied/.test(row.action) ? "pill-critical" : "pill-tactical"}`}>
                          {humanizeAuditAction(row.action)}
                        </span>
                      </td>
                      <td className="text-center text-xs text-steel-200 max-w-md px-3 py-2 leading-relaxed truncate" title={row.description}>
                        {row.description}
                      </td>
                      <td className="text-center font-mono text-xs text-steel-500 whitespace-nowrap">{row.ip_address}</td>
                      <td className="text-center font-mono text-xs text-steel-400 whitespace-nowrap">{row.firearm?.serial_number ?? "—"}</td>
                      <td className="text-center text-steel-500">
                        {hasDetails && <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-steel-900/50">
                        <td colSpan={8} className="px-4 py-4">
                          <AuditDetails metadata={row.metadata} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.last_page > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-steel-800/50 pt-4">
            <div className="text-xs text-steel-400">
              Showing <span className="font-medium text-steel-200">{data.from || 0}</span> to <span className="font-medium text-steel-200">{data.to || 0}</span> of <span className="font-medium text-steel-200">{data.total}</span> entries
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || isLoading}
                className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-steel-400 font-mono">
                Page {page} / {data.last_page}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(data.last_page, p + 1))}
                disabled={page === data.last_page || isLoading}
                className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
