"use client";

import React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, MapPin, RotateCcw } from "lucide-react";
import { DataError } from "@/components/ui/data-error";
import { fmtDate, PURPOSES, cn } from "@/lib/utils";

export type TransactionStatus = "Active" | "Returned" | "Overdue" | "Cancelled";

interface TransactionPerson {
  user_id: number;
  rank?: string | null;
  first_name: string;
  last_name: string;
  username?: string;
  phone?: string | null;
  email?: string | null;
}

interface TransactionFirearm {
  equipment_id: number;
  serial_number: string;
  model: string;
  category?: { category_name?: string | null } | null;
}

export interface TransactionRow {
  transaction_id: number;
  equipment_id: number;
  user_id: number;
  authorized_by: number;
  purpose: number;
  status: TransactionStatus;
  checkout_at: string;
  expected_return_at: string;
  actual_return_at?: string | null;
  gps_tracking_enabled: boolean;
  firearm?: TransactionFirearm | null;
  user?: TransactionPerson | null;
  authorizer?: TransactionPerson | null;
}

export type TransactionSortKey =
  | "transaction"
  | "firearm"
  | "personnel"
  | "purpose"
  | "checkout"
  | "expected_return"
  | "status";

export type SortDirection = "asc" | "desc";

export interface LaravelPage<T> {
  data: T[];
  current_page: number;
  from: number | null;
  to: number | null;
  last_page: number;
  per_page: number;
  total: number;
}

interface TransactionLedgerProps {
  page?: LaravelPage<TransactionRow>;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  canAct: boolean;
  /** Roles that may see firearm positions (the /gps API). */
  canLocate?: boolean;
  hasFilters: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onReturn: (transaction: TransactionRow) => void;
  onLocate?: (transaction: TransactionRow) => void;
  onPageChange: (page: number) => void;
  sort: TransactionSortKey;
  dir: SortDirection;
  onSort: (key: TransactionSortKey) => void;
}

const COLUMNS: Array<{ key: TransactionSortKey; label: string }> = [
  { key: "transaction", label: "Transaction" },
  { key: "firearm", label: "Firearm" },
  { key: "personnel", label: "Personnel" },
  { key: "purpose", label: "Purpose" },
  { key: "checkout", label: "Checkout" },
  { key: "expected_return", label: "Expected Return" },
  { key: "status", label: "Status" },
];

function personName(person?: TransactionPerson | null): string {
  if (!person) return "Unknown";
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}

function statusClass(status: TransactionStatus): string {
  if (status === "Active") return "pill-info";
  if (status === "Overdue") return "pill-critical";
  if (status === "Returned") return "pill-ok";
  return "pill-muted";
}

export function TransactionLedger({
  page,
  isLoading,
  isFetching,
  isError,
  canAct,
  canLocate = false,
  hasFilters,
  onRetry,
  onClearFilters,
  onReturn,
  onLocate,
  onPageChange,
  sort,
  dir,
  onSort,
}: TransactionLedgerProps) {
  const showLocate = canLocate && !!onLocate;
  const showActions = canAct || showLocate;
  const columnCount = showActions ? 8 : 7;
  const rows = page?.data ?? [];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-olive-300">
            {COLUMNS.map((column) => {
              const active = sort === column.key;
              const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={column.key}
                  className="text-center py-2 px-3"
                  aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    onClick={() => onSort(column.key)}
                    title={`Sort by ${column.label.toLowerCase()}`}
                    className={cn(
                      "inline-flex items-center gap-1 uppercase tracking-widest transition hover:text-olive-100",
                      active && "text-olive-100"
                    )}
                  >
                    {column.label}
                    <Icon className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")} />
                  </button>
                </th>
              );
            })}
            {showActions && <th className="text-center py-2 px-3">Action</th>}
          </tr>
        </thead>

        <tbody>
          {isError && (
            <tr>
              <td colSpan={columnCount} className="py-0">
                <DataError onRetry={onRetry} />
              </td>
            </tr>
          )}

          {isLoading && !isError && (
            <tr>
              <td colSpan={columnCount} className="text-center py-6 text-steel-400">
                Loading…
              </td>
            </tr>
          )}

          {!isLoading && !isError && rows.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="text-center py-8 text-steel-500">
                {hasFilters ? (
                  <div className="space-y-1">
                    <p>No transactions match your filter.</p>
                    <button
                      type="button"
                      onClick={onClearFilters}
                      className="text-xs text-olive-400 hover:text-olive-300 underline"
                    >
                      Clear filters
                    </button>
                  </div>
                ) : (
                  "No transactions recorded yet."
                )}
              </td>
            </tr>
          )}

          {rows.map((t) => {
            const canReturn = canAct && (t.status === "Active" || t.status === "Overdue");
            const isOverdue = t.status === "Overdue";
            const isOpen = t.status === "Active" || isOverdue;
            const locatable = showLocate && isOpen && t.gps_tracking_enabled;

            return (
              <tr
                key={t.transaction_id}
                className="border-t border-steel-800 hover:bg-steel-800/30 transition-colors"
              >
                <td className="text-center py-2.5 px-3 font-mono text-xs font-semibold text-olive-200 whitespace-nowrap">
                  #{t.transaction_id}
                </td>

                <td className="text-center py-2.5 px-3">
                  <div className="inline-flex items-center gap-1.5 font-mono text-xs">
                    <span className="font-semibold text-olive-100">{t.firearm?.serial_number ?? "—"}</span>
                    {t.firearm?.model && <span className="text-steel-400 text-xs">({t.firearm.model})</span>}
                    {t.gps_tracking_enabled && !locatable && (
                      <span className="text-[10px] text-emerald-400 font-sans" title="GPS active">
                        ● GPS
                      </span>
                    )}
                  </div>
                </td>

                <td className="text-center py-2.5 px-3 text-xs text-steel-200">
                  <span className="font-medium text-steel-100">
                    {t.user?.rank ? `${t.user.rank} ` : ""}
                    {personName(t.user)}
                  </span>
                </td>

                <td className="text-center py-2.5 px-3 text-xs text-steel-300">
                  {PURPOSES[t.purpose] ?? "—"}
                </td>

                <td className="text-center py-2.5 px-3 font-mono text-xs text-steel-400 whitespace-nowrap">
                  {fmtDate(t.checkout_at)}
                </td>

                <td
                  className={cn(
                    "text-center py-2.5 px-3 font-mono text-xs whitespace-nowrap",
                    isOverdue ? "text-red-400 font-semibold" : "text-steel-400"
                  )}
                >
                  {fmtDate(t.expected_return_at)}
                </td>

                <td className="text-center py-2.5 px-3 whitespace-nowrap">
                  <span className={cn("pill text-[10px]", statusClass(t.status))}>
                    {t.status}
                  </span>
                </td>

                {showActions && (
                  <td className="text-center py-2.5 px-3 whitespace-nowrap">
                    {locatable || canReturn ? (
                      <div className="inline-flex items-center gap-1.5">
                        {locatable && (
                          <button
                            type="button"
                            onClick={() => onLocate!(t)}
                            title="Show where this firearm is and who has it"
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold transition",
                              isOverdue
                                ? "border-red-500/60 bg-red-900/30 text-red-200 hover:bg-red-800/40 animate-pulse"
                                : "border-emerald-600/50 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-800/30"
                            )}
                          >
                            <MapPin className="h-3 w-3" /> {isOverdue ? "Locate" : "GPS"}
                          </button>
                        )}
                        {canReturn && (
                          <button
                            type="button"
                            onClick={() => onReturn(t)}
                            className="btn-secondary px-2.5 py-1 text-xs inline-flex items-center gap-1"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>Return</span>
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-steel-600 text-xs">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Consistent Pagination matching other pages */}
      {page && page.total > 0 && (
        <div className="mt-4 flex items-center justify-between border-t border-steel-800/50 pt-4">
          <div className="text-xs text-steel-400">
            Showing <span className="font-medium text-steel-200">{page.from || 1}</span> to{" "}
            <span className="font-medium text-steel-200">{page.to || rows.length}</span> of{" "}
            <span className="font-medium text-steel-200">{page.total}</span> entries
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, page.current_page - 1))}
              disabled={page.current_page <= 1 || isFetching}
              className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-steel-400 font-mono">
              Page {page.current_page} / {page.last_page || 1}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(page.last_page || 1, page.current_page + 1))}
              disabled={page.current_page >= page.last_page || isFetching}
              className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
