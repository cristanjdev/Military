"use client";

import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { AlertCircle, Filter, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuthStore, hasRole } from "@/store/auth";
import { ActionModal } from "@/components/ui/action-modal";
import { confirmBiometric, isBiometricCancelled } from "@/store/biometric-confirm";
import {
  LaravelPage,
  SortDirection,
  TransactionLedger,
  TransactionRow,
  TransactionSortKey,
  TransactionStatus,
} from "@/components/transactions/transaction-ledger";
import { LocateFirearmModal } from "@/components/transactions/locate-firearm-modal";

const STATUS_FILTERS: Array<{
  value: "" | TransactionStatus;
  label: string;
  dot: string;
}> = [
  { value: "", label: "All", dot: "bg-steel-400" },
  { value: "Active", label: "Active", dot: "bg-blue-400" },
  { value: "Overdue", label: "Overdue", dot: "bg-red-400" },
  { value: "Returned", label: "Returned", dot: "bg-emerald-400" },
  { value: "Cancelled", label: "Cancelled", dot: "bg-steel-500" },
];

interface FirearmOption {
  equipment_id: number;
  serial_number: string;
  model: string;
}

interface PersonnelOption {
  user_id: number;
  rank?: string | null;
  first_name: string;
  last_name: string;
}

function positiveInteger(value: string | null): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AxiosError) {
    const data = error.response?.data as { message?: string } | undefined;
    return data?.message ?? fallback;
  }
  return fallback;
}

function TransactionsPageFallback() {
  return (
    <div className="space-y-5">
      <div className="h-16 animate-pulse rounded-xl bg-steel-800/40" />
      <div className="h-[32rem] animate-pulse rounded-xl bg-steel-800/40" />
    </div>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={<TransactionsPageFallback />}>
      <TransactionsContent />
    </Suspense>
  );
}

function TransactionsContent() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useAuthStore((state) => state.user);
  // Releasing and receiving firearms is the Armory Custodian's job.
  const canAct = hasRole(user, "Administrator", "Armory Custodian");
  const canLocate = hasRole(user, "Administrator", "Command Officer", "S4 Officer", "Armory Custodian");

  const equipmentId = positiveInteger(searchParams.get("equipment_id"));
  const userId = positiveInteger(searchParams.get("user_id"));

  const [status, setStatus] = useState<"" | TransactionStatus>("");
  const [page, setPage] = useState(1);
  const [returnTarget, setReturnTarget] = useState<TransactionRow | null>(null);
  const [returnCondition, setReturnCondition] = useState(2);
  const [showIssuance, setShowIssuance] = useState(false);
  const [locateTarget, setLocateTarget] = useState<TransactionRow | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<TransactionSortKey>("checkout");
  const [dir, setDir] = useState<SortDirection>("desc");

  // Clicking the sorted column flips the order; a new column starts ascending (dates newest first).
  const changeSort = (key: TransactionSortKey) => {
    if (key === sort) {
      setDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setDir(key === "checkout" || key === "expected_return" || key === "transaction" ? "desc" : "asc");
    }
    setPage(1);
  };

  // Search as the user types, without a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const transactionQuery = useQuery<LaravelPage<TransactionRow>>({
    queryKey: ["transactions", status, page, equipmentId, userId, search, sort, dir],
    queryFn: async () => (
      await api.get<LaravelPage<TransactionRow>>("/transactions", {
        params: {
          status: status || undefined,
          search: search || undefined,
          sort,
          dir,
          equipment_id: equipmentId,
          user_id: userId,
          page,
          per_page: 15,
        },
      })
    ).data,
    placeholderData: (previous) => previous,
  });

  const clearContextFilter = (key: "equipment_id" | "user_id") => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete(key);
    setPage(1);
    router.replace(next.size > 0 ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
  };

  const clearFilters = () => {
    setStatus("");
    setSearchInput("");
    setSearch("");
    setPage(1);
    router.replace(pathname, { scroll: false });
  };

  const hasFilters = status !== "" || search !== "" || equipmentId != null || userId != null;

  const returnMutation = useMutation({
    mutationFn: async ({ id, condition }: { id: number; condition: number }) => {
      // Fresh fingerprint scan for this exact transaction (a no-op when biometrics are off).
      const grant = await confirmBiometric("return", `transaction:${id}`);
      return api.patch(`/transactions/${id}/return`, {
        condition_on_return: condition,
        notes: "Returned via UI",
        ...(grant ? { biometric_grant: grant } : {}),
      });
    },
    onSuccess: () => {
      toast.success("Firearm returned and GPS tracking deactivated.");
      setReturnTarget(null);
      setPage(1);
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    },
    onError: (error: unknown) => {
      if (isBiometricCancelled(error)) return;
      toast.error(apiErrorMessage(error, "Return failed."));
    },
  });

  const sweepMutation = useMutation({
    mutationFn: () => api.post<{ flagged: number }>("/transactions/sweep-overdue"),
    onSuccess: ({ data }) => {
      toast.success(
        data.flagged === 1
          ? "1 transaction flagged overdue."
          : `${data.flagged} transactions flagged overdue.`
      );
      setPage(1);
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Unable to sweep overdue transactions.")),
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-olive-50">Transactions</h1>
          <p className="mt-1 max-w-2xl text-sm text-steel-400">
            Review firearm issuance, expected returns, authorization, and completed handovers.
          </p>
        </div>

        {canAct && (
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <button
              type="button"
              onClick={() => sweepMutation.mutate()}
              disabled={sweepMutation.isPending}
              className="btn-secondary min-w-0 px-3 text-xs sm:min-w-36"
            >
              {sweepMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <AlertCircle className="h-4 w-4" />}
              <span className="truncate">{sweepMutation.isPending ? "Checking…" : "Sweep overdue"}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowIssuance(true)}
              className="btn-primary min-w-0 px-3 text-xs sm:min-w-36"
            >
              <Plus className="h-4 w-4" /> <span className="truncate">New issuance</span>
            </button>
          </div>
        )}
      </header>

      <div className="glass rounded-xl p-4 space-y-4">
        <div className="border-b border-steel-800/60 pb-3">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Filter className="h-4 w-4 text-olive-300" />
                <h2 id="transaction-filters-title" className="text-xs font-semibold uppercase tracking-[0.16em] text-olive-300">
                  Filter by status
                </h2>
              </div>

              <div className="flex flex-wrap gap-2" role="group" aria-label="Transaction status filters">
                {STATUS_FILTERS.map((filter) => {
                  const active = status === filter.value;
                  return (
                    <button
                      key={filter.label}
                      type="button"
                      onClick={() => {
                        setStatus(filter.value);
                        setPage(1);
                      }}
                      aria-pressed={active}
                      className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-olive-400/70 ${
                        active
                          ? "border-olive-400/70 bg-olive-700/35 text-olive-50 shadow-[0_0_16px_rgba(118,128,58,0.16)]"
                          : "border-steel-700/70 bg-steel-900/50 text-steel-300 hover:border-olive-600/50 hover:text-olive-100"
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${filter.dot}`} />
                      {filter.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 xl:flex-nowrap xl:justify-end">
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel-500" />
                <input
                  type="text"
                  inputMode="search"
                  enterKeyHint="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search name, serial, or #ID"
                  aria-label="Search transactions"
                  className="input-field h-9 w-full pl-9 pr-8 text-sm"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-steel-400 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => transactionQuery.refetch()}
                disabled={transactionQuery.isFetching}
                aria-label="Refresh transactions"
                title="Refresh transactions"
                className="btn-ghost p-2"
              >
                <RefreshCw className={`h-4 w-4 ${transactionQuery.isFetching ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {(equipmentId || userId) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-steel-800/60 pt-3">
              <span className="text-[10px] uppercase tracking-wider text-steel-500">Context filters</span>
              {equipmentId && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-olive-600/40 bg-olive-900/25 px-2.5 py-1 text-xs text-olive-100">
                  Firearm #{equipmentId}
                  <button
                    type="button"
                    onClick={() => clearContextFilter("equipment_id")}
                    aria-label={`Remove firearm ${equipmentId} filter`}
                    className="rounded-full text-olive-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-olive-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {userId && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-olive-600/40 bg-olive-900/25 px-2.5 py-1 text-xs text-olive-100">
                  Personnel #{userId}
                  <button
                    type="button"
                    onClick={() => clearContextFilter("user_id")}
                    aria-label={`Remove personnel ${userId} filter`}
                    className="rounded-full text-olive-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-olive-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              <button type="button" onClick={clearFilters} className="text-xs text-steel-400 underline-offset-4 hover:text-olive-200 hover:underline">
                Clear all
              </button>
            </div>
          )}
        </div>

        <TransactionLedger
          page={transactionQuery.data}
          isLoading={transactionQuery.isLoading}
          isFetching={transactionQuery.isFetching}
          isError={transactionQuery.isError}
          canAct={canAct}
          canLocate={canLocate}
          onLocate={setLocateTarget}
          hasFilters={hasFilters}
          onRetry={() => { void transactionQuery.refetch(); }}
          onClearFilters={clearFilters}
          onReturn={(transaction) => {
            setReturnTarget(transaction);
            setReturnCondition(2);
          }}
          onPageChange={setPage}
          sort={sort}
          dir={dir}
          onSort={changeSort}
        />
      </div>

      {locateTarget && (
        <LocateFirearmModal transaction={locateTarget} onClose={() => setLocateTarget(null)} />
      )}

      <ActionModal
        open={returnTarget !== null}
        onClose={() => {
          if (!returnMutation.isPending) setReturnTarget(null);
        }}
        onConfirm={() => {
          if (returnTarget) {
            returnMutation.mutate({
              id: returnTarget.transaction_id,
              condition: returnCondition,
            });
          }
        }}
        title="Return Firearm"
        description={`Confirm the return of firearm ${returnTarget?.firearm?.serial_number ?? ""} issued to ${returnTarget?.user?.first_name ?? ""} ${returnTarget?.user?.last_name ?? ""}.`}
        confirmLabel="Confirm Return"
        confirmVariant="primary"
        loading={returnMutation.isPending}
      >
        <div className="space-y-3">
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-widest text-olive-300">Transaction details</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-steel-400">Transaction #</span>
                <p className="font-mono text-olive-100">{returnTarget?.transaction_id}</p>
              </div>
              <div>
                <span className="text-steel-400">Firearm</span>
                <p className="font-mono text-olive-100">{returnTarget?.firearm?.serial_number}</p>
              </div>
              <div>
                <span className="text-steel-400">Model</span>
                <p className="text-olive-100">{returnTarget?.firearm?.model}</p>
              </div>
              <div>
                <span className="text-steel-400">Personnel</span>
                <p className="text-olive-100">
                  {returnTarget?.user?.first_name} {returnTarget?.user?.last_name}
                </p>
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[10px] uppercase tracking-widest text-olive-300">Condition on return</p>
            <label htmlFor="return-condition" className="mb-1 block text-xs text-steel-400">
              Select the firearm&apos;s condition
            </label>
            <select
              id="return-condition"
              value={returnCondition}
              onChange={(event) => setReturnCondition(Number(event.target.value))}
              className="input-field w-full"
              disabled={returnMutation.isPending}
            >
              <option value={1}>Excellent</option>
              <option value={2}>Good</option>
              <option value={3}>Fair</option>
              <option value={4}>Poor</option>
            </select>
          </div>
        </div>
      </ActionModal>

      {showIssuance && (
        <IssuanceModal
          onClose={() => setShowIssuance(false)}
          onSuccess={() => {
            setShowIssuance(false);
            setPage(1);
            qc.invalidateQueries({ queryKey: ["transactions"] });
            qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
          }}
        />
      )}
    </div>
  );
}

function IssuanceModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState(() => ({
    equipment_id: "",
    user_id: "",
    expected_return_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16),
    purpose: 1,
    condition_on_issue: 2,
    notes: "",
  }));
  const [loading, setLoading] = useState(false);

  const firearmsQuery = useQuery<LaravelPage<FirearmOption>>({
    queryKey: ["available-firearms"],
    queryFn: async () => (
      await api.get<LaravelPage<FirearmOption>>("/firearms", {
        params: { availability_status: 1, per_page: 100 },
      })
    ).data,
  });

  const personnelQuery = useQuery<LaravelPage<PersonnelOption>>({
    queryKey: ["personnel-for-issue"],
    queryFn: async () => (
      await api.get<LaravelPage<PersonnelOption>>("/transactions/personnel")
    ).data,
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      // Fresh fingerprint scan for this exact firearm (a no-op when biometrics are off).
      const grant = await confirmBiometric("issue", `equipment:${Number(form.equipment_id)}`);
      await api.post("/transactions/issue", {
        ...form,
        equipment_id: Number(form.equipment_id),
        user_id: Number(form.user_id),
        ...(grant ? { biometric_grant: grant } : {}),
      });
      toast.success("Firearm issued — GPS tracking activated.");
      onSuccess();
    } catch (error: unknown) {
      if (isBiometricCancelled(error)) return;
      toast.error(apiErrorMessage(error, "Issuance failed."));
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={() => { if (!loading) onClose(); }}
      role="presentation"
    >
      <div
        className="glass max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-xl p-5"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="issuance-modal-title"
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="flex items-center justify-between">
            <p id="issuance-modal-title" className="section-title">New issuance</p>
            <button type="button" onClick={onClose} disabled={loading} className="btn-ghost p-1.5" aria-label="Close issuance dialog">
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-steel-400">
            GPS tracking and audit logging activate automatically after approval.
          </p>

          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-widest text-olive-300">Assignment</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="issuance-firearm" className="mb-1 block text-xs text-steel-400">
                  Firearm <span className="text-red-400">*</span>
                </label>
                <select
                  id="issuance-firearm"
                  className="input-field w-full"
                  required
                  disabled={loading || firearmsQuery.isLoading}
                  value={form.equipment_id}
                  onChange={(event) => setForm({ ...form, equipment_id: event.target.value })}
                >
                  <option value="">{firearmsQuery.isLoading ? "Loading firearms…" : "— Select firearm —"}</option>
                  {firearmsQuery.data?.data.map((firearm) => (
                    <option key={firearm.equipment_id} value={firearm.equipment_id}>
                      {firearm.serial_number} · {firearm.model}
                    </option>
                  ))}
                </select>
                {firearmsQuery.isError && <p className="mt-1 text-xs text-red-300">Available firearms could not be loaded.</p>}
              </div>

              <div>
                <label htmlFor="issuance-personnel" className="mb-1 block text-xs text-steel-400">
                  Personnel <span className="text-red-400">*</span>
                </label>
                <select
                  id="issuance-personnel"
                  className="input-field w-full"
                  required
                  disabled={loading || personnelQuery.isLoading || personnelQuery.isError}
                  value={form.user_id}
                  onChange={(event) => setForm({ ...form, user_id: event.target.value })}
                >
                  <option value="">{personnelQuery.isLoading ? "Loading personnel…" : "— Select personnel —"}</option>
                  {personnelQuery.data?.data.map((person) => (
                    <option key={person.user_id} value={person.user_id}>
                      {person.rank} {person.first_name} {person.last_name}
                    </option>
                  ))}
                </select>
                {personnelQuery.isError && (
                  <p className="mt-1 text-xs text-red-300">Personnel options are unavailable for this account.</p>
                )}
              </div>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-widest text-olive-300">Details</p>
            <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
              <div>
                <label htmlFor="expected-return" className="mb-1 block text-xs text-steel-400">
                  Expected return <span className="text-red-400">*</span>
                </label>
                <input
                  id="expected-return"
                  className="input-field h-[42px] w-full"
                  type="datetime-local"
                  required
                  disabled={loading}
                  value={form.expected_return_at}
                  onChange={(event) => setForm({ ...form, expected_return_at: event.target.value })}
                />
              </div>
              <div>
                <label htmlFor="issuance-purpose" className="mb-1 block text-xs text-steel-400">
                  Purpose <span className="text-red-400">*</span>
                </label>
                <select
                  id="issuance-purpose"
                  className="input-field h-[42px] w-full"
                  value={form.purpose}
                  disabled={loading}
                  onChange={(event) => setForm({ ...form, purpose: Number(event.target.value) })}
                >
                  <option value={1}>Training</option>
                  <option value={2}>Operation</option>
                </select>
              </div>
              <div>
                <label htmlFor="issuance-condition" className="mb-1 block text-xs text-steel-400">
                  Condition <span className="text-red-400">*</span>
                </label>
                <select
                  id="issuance-condition"
                  className="input-field h-[42px] w-full"
                  value={form.condition_on_issue}
                  disabled={loading}
                  onChange={(event) => setForm({ ...form, condition_on_issue: Number(event.target.value) })}
                >
                  <option value={1}>Excellent</option>
                  <option value={2}>Good</option>
                  <option value={3}>Fair</option>
                  <option value={4}>Poor</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="issuance-notes" className="mb-1 block text-xs text-steel-400">Notes</label>
            <textarea
              id="issuance-notes"
              className="input-field h-16 w-full resize-y"
              placeholder="Optional operational notes"
              disabled={loading}
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
            />
          </div>

          <div className="flex flex-col-reverse gap-2 pt-3 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} disabled={loading} className="btn-secondary text-xs">Cancel</button>
            <button
              disabled={loading || personnelQuery.isError || firearmsQuery.isError}
              className="btn-primary text-xs"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Authorize issuance
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
