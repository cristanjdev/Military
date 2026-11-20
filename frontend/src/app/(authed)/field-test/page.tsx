"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  ArrowLeft, Bell, CheckCircle2, Clock, Copy, Crosshair, Flag, Gauge, Loader2, LocateFixed, MapPin,
  MapPinned, Play, Radio, Square, Trash2, Undo2, Wifi, WifiOff, XCircle, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtDate } from "@/lib/utils";
import { DataError } from "@/components/ui/data-error";

/* ---------- API shapes ---------- */

interface Person { rank?: string | null; first_name: string; last_name: string }
interface Mark { mark_id: number; kind: string; occurred_at: string }

interface FieldTest {
  field_test_id: number;
  equipment_id: number;
  started_at: string;
  ended_at: string | null;
  reference_latitude: number | null;
  reference_longitude: number | null;
  firearm?: { serial_number: string; model?: string | null } | null;
  starter?: Person | null;
  marks?: Mark[];
}

type Status = "ok" | "missed" | "waiting" | "too_short";

interface Crossing { kind: "entered" | "left"; tapped_at: string; detected_at: string | null; delay_s: number | null; status: Status }
interface AlertTrial { kind: "signal_lost" | "signal_restored"; tapped_at: string; alert_at: string | null; delay_s: number | null; status: Status }

interface Tally { samples: number; correct: number; missed: number; false_count: number; pct: number | null; target_pct: number; pass: boolean | null }

interface Report {
  interval_seconds: number;
  positions: number;
  last_position: {
    captured_at: string; seconds_ago: number; latitude: number; longitude: number;
    satellites: number | null; inside_zone: boolean | null; distance_m: number | null;
  } | null;
  phases: { spot: boolean; range: boolean; zone: boolean; hotspot_off: boolean };
  metrics: {
    latency: { samples: number; limit: number; target_pct: number; pct: number | null; median: number | null; p95: number | null; max: number | null; pass: boolean | null };
    distance: { samples: number; has_reference: boolean; limit: number; target_pct: number; pct: number | null; median: number | null; p90: number | null; max: number | null; pass: boolean | null };
    range: { samples: number; has_reference: boolean; target_m: number; farthest_m: number | null; current_m: number | null; lost: boolean; pass: boolean | null };
    reliability: { samples: number; received: number; missed: number; pct: number | null; target_pct: number; pass: boolean | null };
    geofence: Tally & { crossings: Crossing[]; false: { kind: string; detected_at: string }[] };
    alerts: Tally & { trials: AlertTrial[]; false: { kind: string; alert_at: string }[]; silent_seconds: number };
  };
}

interface TestPayload { test: FieldTest; report: Report }
interface IndexPayload {
  tests: FieldTest[];
  firearms: { equipment_id: number; serial_number: string; model?: string | null; holder?: string | null }[];
}

/* ---------- formatting ---------- */

const errorText = (e: unknown, fallback: string) =>
  (e as AxiosError<{ message?: string }>)?.response?.data?.message ?? fallback;

const pct = (v: number | null) => (v === null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);
const m = (v: number | null) => (v === null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)} m`);

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  return s % 60 ? `${min} min ${s % 60} s` : `${min} min`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const MARK_LABEL: Record<string, string> = {
  spot_start: "Tracker placed on the spot",
  spot_end: "Tracker picked up from the spot",
  range_start: "Range walk started",
  range_end: "Range walk finished",
  zone_start: "Zone walks started",
  zone_end: "Zone walks finished",
  entered: "Entered the zone",
  left: "Left the zone",
  hotspot_off: "Hotspot turned off",
  hotspot_on: "Hotspot turned on",
};

/** When the step that `open` begins was last started, or null if it is not running. */
function openedAt(marks: Mark[], open: string, close: string): string | null {
  let at: string | null = null;
  for (const mk of marks) {
    if (mk.kind === open) at = mk.occurred_at;
    else if (mk.kind === close) at = null;
  }
  return at;
}

/** "10.3157, 123.8854" or "10.3157 123.8854", as copied from Google Maps. */
function parseCoords(text: string): { latitude: number; longitude: number } | null {
  const hit = text.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!hit) return null;
  const latitude = Number(hit[1]);
  const longitude = Number(hit[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/* ---------- results table ---------- */

interface ResultRow { metric: string; target: string; actual: string; detail: string; pass: boolean | null }

function resultRows(r: Report): ResultRow[] {
  const { latency: l, distance: d, range: g, reliability: rel, geofence: z, alerts: a } = r.metrics;
  return [
    {
      metric: "Update latency",
      target: `≤ ${l.limit} s for ${l.target_pct}% of updates`,
      actual: l.pct === null ? "No data yet" : `${pct(l.pct)} within ${l.limit} s`,
      detail: l.samples ? `Typical ${duration(l.median)}, slowest ${duration(l.max)}, from ${l.samples} updates` : "",
      pass: l.pass,
    },
    {
      metric: "Distance error",
      target: `≤ ${d.limit} m for ${d.target_pct}% of positions`,
      actual: d.pct === null ? (d.has_reference ? "No data yet" : "Set the marked spot") : `${pct(d.pct)} within ${d.limit} m`,
      detail: d.samples ? `Typical ${m(d.median)} off, 90% within ${m(d.p90)}, from ${d.samples} positions` : "",
      pass: d.pass,
    },
    {
      metric: "Hotspot range",
      target: `Tracking at ${g.target_m} m or more from the phone`,
      actual: g.farthest_m === null ? (g.has_reference ? "No data yet" : "Set the marked spot") : m(g.farthest_m),
      detail: g.farthest_m === null ? ""
        : g.lost ? "Farthest point that still sent live; updates stopped beyond it"
        : "Still sending at this distance: walk farther to find the limit",
      pass: g.pass,
    },
    {
      metric: "Signal reliability",
      target: `≥ ${rel.target_pct}% of updates received`,
      actual: rel.pct === null ? "No data yet" : pct(rel.pct),
      detail: rel.samples ? `${rel.received} received, ${rel.missed} missed (one expected every ${r.interval_seconds} s)` : "",
      pass: rel.pass,
    },
    {
      metric: "Geofence accuracy",
      target: `≥ ${z.target_pct}% of zone crossings detected`,
      actual: z.pct === null ? "No data yet" : pct(z.pct),
      detail: z.samples ? `${z.correct} of ${z.correct + z.missed} crossings detected, ${z.false_count} false` : "",
      pass: z.pass,
    },
    {
      metric: "Alert trigger accuracy",
      target: `≥ ${a.target_pct}% of alerts fired`,
      actual: a.pct === null ? "No data yet" : pct(a.pct),
      detail: a.samples ? `${a.correct} of ${a.correct + a.missed} expected alerts fired, ${a.false_count} false` : "",
      pass: a.pass,
    },
  ];
}

function ResultsTable({ report, test }: { report: Report; test: FieldTest }) {
  const rows = resultRows(report);

  const copy = async () => {
    const text = [
      ["Metric", "Target", "Actual", "Result"].join("\t"),
      ...rows.map((r) => [r.metric, r.target, r.actual + (r.detail ? ` (${r.detail})` : ""),
        r.pass === null ? "No data" : r.pass ? "Met" : "Not met"].join("\t")),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Table copied", { description: "Paste it into Word, Excel or your slides." });
    } catch {
      toast.error("Could not copy the table.");
    }
  };

  return (
    <section className="glass rounded-xl p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-olive-50">{test.ended_at ? "Results" : "Results so far"}</h2>
          <p className="text-xs text-steel-400">
            {test.firearm?.serial_number ?? "Firearm"} · {fmtDate(test.started_at, "MMMM d, yyyy h:mm a")}
            {test.ended_at ? ` to ${fmtDate(test.ended_at, "h:mm a")}` : ", still running"}
          </p>
        </div>
        <button type="button" onClick={copy} className="btn-secondary text-xs"><Copy className="h-3.5 w-3.5" /> Copy table</button>
      </div>

      {/* Phone: one block per metric. Wider screens: a real table. */}
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.metric} className="rounded-lg border border-steel-800 bg-steel-900/40 p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-olive-50">{r.metric}</p>
              <ResultPill pass={r.pass} />
            </div>
            <p className="mt-1 text-xs text-steel-400">Target: {r.target}</p>
            <p className="mt-1 text-sm text-steel-100">{r.actual}</p>
            {r.detail && <p className="text-xs text-steel-400">{r.detail}</p>}
          </li>
        ))}
      </ul>
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="text-left text-xs text-steel-400">
            <th className="py-2 pr-3 font-medium">Metric</th>
            <th className="py-2 pr-3 font-medium">Target</th>
            <th className="py-2 pr-3 font-medium">Actual</th>
            <th className="py-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.metric} className="border-t border-steel-800 align-top">
              <td className="py-2.5 pr-3 font-medium text-olive-50">{r.metric}</td>
              <td className="py-2.5 pr-3 text-steel-300">{r.target}</td>
              <td className="py-2.5 pr-3">
                <p className="text-steel-100">{r.actual}</p>
                {r.detail && <p className="text-xs text-steel-400">{r.detail}</p>}
              </td>
              <td className="py-2.5"><ResultPill pass={r.pass} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ResultPill({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="pill pill-muted shrink-0">No data</span>;
  return pass
    ? <span className="pill pill-ok shrink-0">Met</span>
    : <span className="pill pill-critical shrink-0">Not met</span>;
}

/* ---------- small pieces ---------- */

function Step({
  n, icon: Icon, title, children, running,
}: { n: number; icon: LucideIcon; title: string; children: React.ReactNode; running?: boolean }) {
  return (
    <section className={cn("glass rounded-xl p-4 sm:p-5 space-y-3", running && "ring-1 ring-olive-500/60")}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-olive-700/50 text-xs font-semibold text-olive-100">{n}</span>
        {/* The icon only decorates; on narrow phones the title needs the room. */}
        <Icon className="hidden h-4 w-4 shrink-0 text-olive-300 sm:block" aria-hidden />
        <h2 className="min-w-0 text-base font-semibold text-olive-50">{title}</h2>
        {running && (
          <>
            <span className="pill pill-tactical ml-auto hidden shrink-0 sm:inline-flex">Running</span>
            <span className="ml-auto h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-olive-400 sm:hidden" role="img" aria-label="Running" />
          </>
        )}
      </div>
      {children}
    </section>
  );
}

function StatusLine({ status, delay, waitingText }: { status: Status; delay: number | null; waitingText: string }) {
  if (status === "ok") return <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> after {duration(delay !== null ? Math.max(0, delay) : null)}</span>;
  if (status === "waiting") return <span className="inline-flex items-center gap-1 text-steel-300"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {waitingText}</span>;
  if (status === "too_short") return <span className="text-amber-300">Hotspot was not off long enough; not counted</span>;
  return <span className="inline-flex items-center gap-1 text-red-300"><XCircle className="h-3.5 w-3.5" /> Not detected</span>;
}

/* ---------- page ---------- */

export default function FieldTestPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-steel-400" /></div>}>
      <FieldTestInner />
    </Suspense>
  );
}

function FieldTestInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const id = Number(params.get("id")) || null;

  const open = (testId: number | null) => router.replace(testId ? `${pathname}?id=${testId}` : pathname);

  return id ? <TestView id={id} onBack={() => open(null)} /> : (
    <div className="space-y-2">
      <Link href="/settings" className="btn-ghost text-xs -ml-2"><ArrowLeft className="h-3.5 w-3.5" /> Settings</Link>
      <TestList onOpen={open} />
    </div>
  );
}

function PageHeading({ children }: { children?: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-olive-50 flex items-center gap-2"><Gauge className="h-5 w-5 text-olive-300" /> Field Test</h1>
      <p className="text-sm text-steel-400 max-w-2xl">
        {children ?? "Measure the tracker outdoors. Tap each step as you do it. The numbers come from the tracker's own positions and the system's alerts during the test."}
      </p>
    </div>
  );
}

/* ---------- list of tests + start ---------- */

function TestList({ onOpen }: { onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const [equipmentId, setEquipmentId] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["field-tests"],
    queryFn: async () => (await api.get<IndexPayload>("/field-tests")).data,
    refetchInterval: 30_000,
  });

  const start = useMutation({
    mutationFn: async (equipment: number) => (await api.post<TestPayload>("/field-tests", { equipment_id: equipment })).data,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["field-tests"] });
      qc.setQueryData(["field-test", res.test.field_test_id], res);
      onOpen(res.test.field_test_id);
    },
    onError: (e) => toast.error(errorText(e, "Could not start the test.")),
  });

  const firearms = data?.firearms ?? [];
  const tests = data?.tests ?? [];
  // With a single firearm issued, it is already chosen.
  const chosen = equipmentId || (firearms.length === 1 ? String(firearms[0].equipment_id) : "");

  return (
    <div className="space-y-5">
      <PageHeading />

      <section className="glass rounded-xl p-4 sm:p-5 space-y-3">
        <h2 className="text-base font-semibold text-olive-50">Start a test</h2>
        <div className="text-sm text-steel-300 space-y-1">
          <p>Before you go out:</p>
          <ol className="list-decimal pl-5 space-y-0.5 text-steel-400">
            <li>Charge the tracker.</li>
            <li>Issue a firearm with GPS tracking on.</li>
            <li>Turn on the phone hotspot with the standard name and password.</li>
            <li>Pick an open area near the edge of a zone, with a clear view of the sky.</li>
          </ol>
          <p className="text-steel-400">Two people work best: one carries the tracker, the other keeps this page open and taps.</p>
        </div>

        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-steel-400" />
        ) : isError ? (
          <DataError onRetry={() => refetch()} />
        ) : firearms.length === 0 ? (
          <p className="rounded-lg border border-amber-600/40 bg-amber-900/20 p-3 text-sm text-amber-100">
            No firearm is issued with GPS tracking on. Issue one first, then come back here.
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <select className="input-field w-full sm:max-w-sm" value={chosen} onChange={(e) => setEquipmentId(e.target.value)} aria-label="Firearm to test">
              <option value="">Choose a firearm</option>
              {firearms.map((f) => (
                <option key={f.equipment_id} value={f.equipment_id}>
                  {f.serial_number}{f.model ? ` · ${f.model}` : ""}{f.holder ? ` · ${f.holder}` : ""}
                </option>
              ))}
            </select>
            <button type="button" className="btn-primary" disabled={!chosen || start.isPending}
              onClick={() => start.mutate(Number(chosen))}>
              {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start test
            </button>
          </div>
        )}
      </section>

      <section className="glass rounded-xl p-4 sm:p-5 space-y-3">
        <h2 className="text-base font-semibold text-olive-50">Past tests</h2>
        {tests.length === 0 ? (
          <p className="text-sm text-steel-400">No tests yet.</p>
        ) : (
          <ul className="divide-y divide-steel-800">
            {tests.map((t) => (
              <li key={t.field_test_id}>
                <button type="button" onClick={() => onOpen(t.field_test_id)}
                  className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:text-olive-50">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-steel-100">{t.firearm?.serial_number ?? `Firearm #${t.equipment_id}`}</span>
                    <span className="block text-xs text-steel-400">
                      {fmtDate(t.started_at, "MMMM d, yyyy h:mm a")}
                      {t.starter ? ` · ${t.starter.rank ? `${t.starter.rank} ` : ""}${t.starter.first_name} ${t.starter.last_name}` : ""}
                    </span>
                  </span>
                  {t.ended_at
                    ? <span className="pill pill-muted shrink-0">Finished</span>
                    : <span className="pill pill-tactical shrink-0">Running</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------- one test ---------- */

function TestView({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const key = ["field-test", id];
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState<"finish" | "delete" | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<TestPayload>(`/field-tests/${id}`)).data,
    // Every 5 s while running; after the end, only while an alert or crossing is still being checked.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (!d.test.ended_at) return 5_000;
      const { geofence, alerts } = d.report.metrics;
      return [...geofence.crossings, ...alerts.trials].some((r) => r.status === "waiting") ? 15_000 : false;
    },
  });

  const running = !!data && !data.test.ended_at;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  const apply = (res: TestPayload) => qc.setQueryData(key, res);
  /** Destructive buttons ask for a second tap within 4 seconds. */
  const twoStep = (what: "finish" | "delete", run: () => void) => {
    if (confirm === what) {
      setConfirm(null);
      run();
    } else {
      setConfirm(what);
    }
  };
  const onError = (fallback: string) => (e: unknown) => toast.error(errorText(e, fallback));

  const tap = useMutation({
    mutationFn: async (kind: string) => (await api.post<TestPayload>(`/field-tests/${id}/marks`, { kind })).data,
    onSuccess: apply,
    onError: onError("Could not save the tap."),
  });
  const undo = useMutation({
    mutationFn: async () => (await api.post<TestPayload>(`/field-tests/${id}/undo`)).data,
    onSuccess: (res) => { apply(res); toast.success("Last tap removed"); },
    onError: onError("Could not undo."),
  });
  const finish = useMutation({
    mutationFn: async () => (await api.post<TestPayload>(`/field-tests/${id}/finish`)).data,
    onSuccess: (res) => { apply(res); qc.invalidateQueries({ queryKey: ["field-tests"] }); toast.success("Test finished"); },
    onError: onError("Could not finish the test."),
  });
  const remove = useMutation({
    mutationFn: async () => api.delete(`/field-tests/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["field-tests"] }); toast.success("Test deleted"); onBack(); },
    onError: onError("Could not delete the test."),
  });

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-steel-400" /></div>;
  if (isError || !data) return <div className="space-y-4"><BackButton onBack={onBack} /><DataError onRetry={() => refetch()} /></div>;

  const { test, report } = data;
  const marks = test.marks ?? [];
  const lastMark = marks[marks.length - 1];
  const busy = tap.isPending;

  return (
    <div className="space-y-5">
      <BackButton onBack={onBack} />
      <PageHeading>
        {test.firearm?.serial_number ?? `Firearm #${test.equipment_id}`}
        {test.firearm?.model ? ` · ${test.firearm.model}` : ""} · started {fmtDate(test.started_at, "MMMM d, yyyy h:mm a")}
      </PageHeading>

      {test.ended_at && <ResultsTable report={report} test={test} />}

      {running && <LiveStatus report={report} />}

      {running && (
        <>
          <SpotStep test={test} report={report} onSaved={apply} />
          <DistanceStep marks={marks} report={report} now={now} busy={busy} onTap={tap.mutate} hasSpot={report.metrics.distance.has_reference} />
          <RangeStep marks={marks} report={report} now={now} busy={busy} onTap={tap.mutate} hasSpot={report.metrics.range.has_reference} />
          <ZoneStep marks={marks} report={report} busy={busy} onTap={tap.mutate} />
          <AlertStep marks={marks} report={report} now={now} busy={busy} onTap={tap.mutate} />
          <ResultsTable report={report} test={test} />
        </>
      )}

      {!running && <Details report={report} />}

      <div className="flex flex-wrap items-center gap-2">
        {running && (
          <>
            <button type="button" className="btn-secondary text-xs" disabled={!lastMark || undo.isPending} onClick={() => undo.mutate()}>
              <Undo2 className="h-3.5 w-3.5" /> Undo last tap{lastMark ? `: ${MARK_LABEL[lastMark.kind] ?? lastMark.kind}` : ""}
            </button>
            <button type="button" className="btn-primary text-xs" disabled={finish.isPending}
              onClick={() => twoStep("finish", () => finish.mutate())}>
              <Flag className="h-3.5 w-3.5" /> {confirm === "finish" ? "Tap again to finish" : "Finish test"}
            </button>
          </>
        )}
        <button type="button" className="btn-ghost text-xs text-red-300" disabled={remove.isPending}
          onClick={() => twoStep("delete", () => remove.mutate())}>
          <Trash2 className="h-3.5 w-3.5" /> {confirm === "delete" ? "Tap again to delete this test" : "Delete test"}
        </button>
      </div>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="btn-ghost text-xs -ml-2">
      <ArrowLeft className="h-3.5 w-3.5" /> All tests
    </button>
  );
}

/** What the tracker is doing right now. */
function LiveStatus({ report }: { report: Report }) {
  const p = report.last_position;
  const stale = !p || p.seconds_ago > report.interval_seconds * 2 + 15;

  return (
    <section className={cn("rounded-xl border p-3 text-sm",
      stale ? "border-amber-600/40 bg-amber-900/20 text-amber-100" : "border-emerald-600/40 bg-emerald-900/20 text-emerald-100")}>
      {!p ? (
        <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin shrink-0" />
          Waiting for the tracker&apos;s first position. Keep the hotspot on and the tracker outdoors.</p>
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {stale ? <WifiOff className="h-4 w-4 shrink-0" /> : <Wifi className="h-4 w-4 shrink-0" />}
          <span>Last position {duration(p.seconds_ago)} ago</span>
          {p.satellites !== null && <span>{p.satellites} satellites</span>}
          {p.distance_m !== null && <span>{m(p.distance_m)} from the spot</span>}
          {p.inside_zone !== null && <span>{p.inside_zone ? "Inside a zone" : "Outside all zones"}</span>}
        </p>
      )}
    </section>
  );
}

/* ---------- step 1: marked spot ---------- */

function SpotStep({ test, report, onSaved }: { test: FieldTest; report: Report; onSaved: (r: TestPayload) => void }) {
  const has = test.reference_latitude !== null && test.reference_longitude !== null;
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(!has);
  const [locating, setLocating] = useState(false);

  const save = useMutation({
    mutationFn: async (c: { latitude: number; longitude: number }) =>
      (await api.patch<TestPayload>(`/field-tests/${test.field_test_id}/reference`, c)).data,
    onSuccess: (res) => { onSaved(res); setEditing(false); setText(""); toast.success("Marked spot saved"); },
    onError: (e) => toast.error(errorText(e, "Could not save the spot.")),
  });

  const parsed = parseCoords(text);

  const usePhone = () => {
    if (!navigator.geolocation) { toast.error("This browser cannot read the phone's location."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); setText(`${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`); },
      () => { setLocating(false); toast.error("Could not get the phone's location. Allow location access, or paste the coordinates."); },
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  };

  return (
    <Step n={1} icon={MapPin} title="Mark a spot">
      <p className="text-sm text-steel-400">
        Pick a spot you can find exactly, such as a corner or a post. In Google Maps, press and hold that spot: its
        coordinates appear at the top. Copy them here. That is more exact than the phone&apos;s own location.
      </p>
      {has && !editing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono text-steel-100">{test.reference_latitude?.toFixed(6)}, {test.reference_longitude?.toFixed(6)}</span>
          <a className="text-olive-300 underline underline-offset-2 text-xs" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps?q=${test.reference_latitude},${test.reference_longitude}`}>Check on map</a>
          <button type="button" className="btn-ghost text-xs" onClick={() => setEditing(true)}>Change</button>
          {report.last_position?.distance_m !== null && report.last_position && (
            <span className="text-xs text-steel-400">Tracker is {m(report.last_position.distance_m)} from it now</span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="input-field w-full sm:max-w-sm font-mono" placeholder="10.315700, 123.885400"
              value={text} onChange={(e) => setText(e.target.value)} aria-label="Coordinates of the marked spot" inputMode="decimal" />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary text-xs" onClick={usePhone} disabled={locating}>
                {locating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5" />} Use this phone&apos;s location
              </button>
              <button type="button" className="btn-primary text-xs" disabled={!parsed || save.isPending} onClick={() => parsed && save.mutate(parsed)}>
                Save
              </button>
            </div>
          </div>
          {text && !parsed && <p className="text-xs text-amber-300">Enter latitude and longitude, like 10.315700, 123.885400</p>}
          {has && <button type="button" className="btn-ghost text-xs" onClick={() => setEditing(false)}>Cancel</button>}
        </div>
      )}
    </Step>
  );
}

/* ---------- step 2: distance error ---------- */

interface StepProps { marks: Mark[]; report: Report; now: number; busy: boolean; onTap: (kind: string) => void }

function DistanceStep({ marks, report, now, busy, onTap, hasSpot }: StepProps & { hasSpot: boolean }) {
  const since = openedAt(marks, "spot_start", "spot_end");
  const elapsed = since ? (now - new Date(since).getTime()) / 1000 : 0;
  const d = report.metrics.distance;

  return (
    <Step n={2} icon={Crosshair} title="Distance error" running={!!since}>
      <p className="text-sm text-steel-400">
        Put the tracker on the marked spot and leave it there for 10 minutes. Tap Start once it is in place, and Stop
        before you pick it up.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {since ? (
          <button type="button" className="btn-danger" disabled={busy} onClick={() => onTap("spot_end")}><Square className="h-4 w-4" /> Stop</button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !hasSpot} onClick={() => onTap("spot_start")}><Play className="h-4 w-4" /> Start</button>
        )}
        {since && (
          <span className={cn("font-mono text-lg", elapsed >= 600 ? "text-emerald-300" : "text-steel-100")}>{clock(elapsed)}</span>
        )}
        {since && elapsed >= 600 && <span className="text-sm text-emerald-300">10 minutes reached. You can stop.</span>}
        {!hasSpot && <span className="text-xs text-steel-400">Mark the spot first.</span>}
      </div>
      {d.samples > 0 && (
        <p className="text-sm text-steel-300">
          {d.samples} positions so far · typical {m(d.median)} off · {pct(d.pct)} within {d.limit} m
        </p>
      )}
    </Step>
  );
}

/* ---------- step 3: hotspot range ---------- */

function RangeStep({ marks, report, now, busy, onTap, hasSpot }: StepProps & { hasSpot: boolean }) {
  const since = openedAt(marks, "range_start", "range_end");
  const elapsed = since ? (now - new Date(since).getTime()) / 1000 : 0;
  const g = report.metrics.range;

  return (
    <Step n={3} icon={Radio} title="Hotspot range" running={!!since}>
      <p className="text-sm text-steel-400">
        Leave the phone with the hotspot on the marked spot. Tap Start, then carry the tracker away slowly in a straight
        line. Stop every 10 m for half a minute. When the tracker stops updating (no new position for over a minute),
        walk back to the phone and tap Stop.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {since ? (
          <button type="button" className="btn-danger" disabled={busy} onClick={() => onTap("range_end")}><Square className="h-4 w-4" /> Stop</button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !hasSpot} onClick={() => onTap("range_start")}><Play className="h-4 w-4" /> Start</button>
        )}
        {since && <span className="font-mono text-lg text-steel-100">{clock(elapsed)}</span>}
        {!hasSpot && <span className="text-xs text-steel-400">Mark the spot first.</span>}
      </div>
      {(since || g.farthest_m !== null) && (
        <div className="text-sm text-steel-300 space-y-0.5">
          {since && g.current_m !== null && <p>Tracker is about {m(g.current_m)} from the phone.</p>}
          {g.farthest_m !== null && <p>Farthest live position: <span className="text-olive-50 font-medium">{m(g.farthest_m)}</span></p>}
          {g.lost && <p className="text-amber-300">Updates stopped beyond it.</p>}
        </div>
      )}
    </Step>
  );
}

/* ---------- step 4: geofence ---------- */

function ZoneStep({ marks, report, busy, onTap }: Omit<StepProps, "now">) {
  const running = !!openedAt(marks, "zone_start", "zone_end");
  const z = report.metrics.geofence;
  const inside = report.last_position?.inside_zone;

  return (
    <Step n={4} icon={MapPinned} title="Geofence accuracy" running={running}>
      <p className="text-sm text-steel-400">
        Stand inside a zone, near its edge. Tap Start. Walk out about 20 m past the edge and tap <b className="text-steel-200">Left the zone</b> the
        moment you cross. Wait 1 minute, walk back in and tap <b className="text-steel-200">Entered the zone</b>. Wait 1 minute. Repeat about 10 times.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onTap("left")}>Left the zone</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onTap("entered")}>Entered the zone</button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => onTap("zone_end")}><Square className="h-4 w-4" /> Stop</button>
          </>
        ) : (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onTap("zone_start")}><Play className="h-4 w-4" /> Start</button>
        )}
        {inside !== null && inside !== undefined && (
          <span className="text-xs text-steel-400">The system sees the tracker {inside ? "inside a zone" : "outside all zones"}.</span>
        )}
      </div>
      {z.crossings.length > 0 && (
        <ul className="space-y-1 text-sm">
          {z.crossings.map((c, i) => (
            <li key={c.tapped_at + i} className="flex flex-wrap items-center gap-x-3">
              <span className="whitespace-nowrap text-steel-200 sm:w-48">{c.kind === "left" ? "Left" : "Entered"} at {fmtDate(c.tapped_at, "h:mm:ss a")}</span>
              <StatusLine status={c.status} delay={c.delay_s} waitingText="Checking…" />
            </li>
          ))}
          {z.false.map((f) => (
            <li key={f.detected_at} className="text-amber-300">
              {f.kind === "left" ? "Left" : "Entered"} detected at {fmtDate(f.detected_at, "h:mm:ss a")} with no tap (GPS drift across the edge)
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

/* ---------- step 5: alerts ---------- */

function AlertStep({ marks, report, now, busy, onTap }: StepProps) {
  const offSince = openedAt(marks, "hotspot_off", "hotspot_on");
  const elapsed = offSince ? (now - new Date(offSince).getTime()) / 1000 : 0;
  const a = report.metrics.alerts;
  const minOff = Math.ceil((a.silent_seconds + 60) / 60);
  const lostFired = offSince && a.trials.some((t) => t.kind === "signal_lost" && t.tapped_at && t.status === "ok"
    && new Date(t.tapped_at).getTime() >= new Date(offSince).getTime() - 1000);

  return (
    <Step n={5} icon={Bell} title="Alert trigger accuracy" running={!!offSince}>
      <p className="text-sm text-steel-400">
        Turn the hotspot off and tap the button. Keep it off for at least {minOff} minutes, until the Signal Lost alert
        appears. Then turn it back on and tap again. Wait for Signal Restored. Repeat 5 times.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {offSince ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onTap("hotspot_on")}><Wifi className="h-4 w-4" /> I turned the hotspot on</button>
        ) : (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onTap("hotspot_off")}><WifiOff className="h-4 w-4" /> I turned the hotspot off</button>
        )}
        {offSince && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Clock className="h-4 w-4 text-steel-400" />
            <span className="font-mono text-lg text-steel-100">{clock(elapsed)}</span>
            <span className={lostFired ? "text-emerald-300" : "text-steel-400"}>
              {lostFired ? "Signal Lost arrived. You can turn it back on." : "Waiting for Signal Lost…"}
            </span>
          </span>
        )}
      </div>
      {a.trials.length > 0 && (
        <ul className="space-y-1 text-sm">
          {a.trials.map((t, i) => (
            <li key={t.tapped_at + t.kind + i} className="flex flex-wrap items-center gap-x-3">
              <span className="whitespace-nowrap text-steel-200 sm:w-72">
                {t.kind === "signal_lost" ? "Off" : "On"} at {fmtDate(t.tapped_at, "h:mm:ss a")}: {t.kind === "signal_lost" ? "Signal Lost" : "Signal Restored"}
              </span>
              <StatusLine status={t.status} delay={t.delay_s} waitingText="Waiting for the alert…" />
            </li>
          ))}
          {a.false.map((f) => (
            <li key={f.alert_at + f.kind} className="text-amber-300">
              {f.kind === "signal_lost" ? "Signal Lost" : "Signal Restored"} at {fmtDate(f.alert_at, "h:mm:ss a")} with no hotspot change
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

/* ---------- finished test: what was behind each number ---------- */

function Details({ report }: { report: Report }) {
  const z = report.metrics.geofence;
  const a = report.metrics.alerts;
  const items = useMemo(() => [
    ...z.crossings.map((c) => ({ at: c.tapped_at, text: `${c.kind === "left" ? "Left" : "Entered"} the zone`, status: c.status, delay: c.delay_s })),
    ...a.trials.map((t) => ({ at: t.tapped_at, text: t.kind === "signal_lost" ? "Hotspot off: Signal Lost" : "Hotspot on: Signal Restored", status: t.status, delay: t.delay_s })),
  ].sort((x, y) => x.at.localeCompare(y.at)), [z.crossings, a.trials]);

  if (items.length === 0 && z.false.length === 0 && a.false.length === 0) return null;

  return (
    <section className="glass rounded-xl p-4 sm:p-5 space-y-2">
      <h2 className="text-base font-semibold text-olive-50">Each try</h2>
      <ul className="space-y-1 text-sm">
        {items.map((it, i) => (
          <li key={it.at + i} className="flex flex-wrap items-center gap-x-3">
            <span className="whitespace-nowrap text-steel-400 sm:w-24">{fmtDate(it.at, "h:mm:ss a")}</span>
            <span className="whitespace-nowrap text-steel-200 sm:w-64">{it.text}</span>
            <StatusLine status={it.status} delay={it.delay} waitingText="Checking…" />
          </li>
        ))}
        {z.false.map((f) => (
          <li key={f.detected_at} className="text-amber-300">
            {fmtDate(f.detected_at, "h:mm:ss a")}: zone {f.kind === "left" ? "exit" : "entry"} detected with no crossing (false)
          </li>
        ))}
        {a.false.map((f) => (
          <li key={f.alert_at + f.kind} className="text-amber-300">
            {fmtDate(f.alert_at, "h:mm:ss a")}: {f.kind === "signal_lost" ? "Signal Lost" : "Signal Restored"} with no hotspot change (false)
          </li>
        ))}
      </ul>
    </section>
  );
}
