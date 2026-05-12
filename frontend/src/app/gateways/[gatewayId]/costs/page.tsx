"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { useAuth } from "@/auth/clerk";

import { ApiError } from "@/api/mutator";
import {
  type getGatewayApiV1GatewaysGatewayIdGetResponse,
  useGetGatewayApiV1GatewaysGatewayIdGet,
} from "@/api/generated/gateways/gateways";
import {
  type usageCostApiV1OpenclawGatewayIdUsageCostGetResponse,
  useUsageCostApiV1OpenclawGatewayIdUsageCostGet,
} from "@/api/generated/openclaw/openclaw";
import type { UsageCostRow } from "@/api/generated/model";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOrganizationMembership } from "@/lib/use-organization-membership";

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const defaultRange = () => {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 30);
  return { from: isoDate(from), to: isoDate(to) };
};

const formatUsd = (value?: number | null) => {
  const v = typeof value === "number" ? value : 0;
  return v.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
};

const formatNumber = (value?: number | null) => {
  const v = typeof value === "number" ? value : 0;
  return v.toLocaleString();
};

export default function GatewayCostsPage() {
  const router = useRouter();
  const params = useParams();
  const { isSignedIn } = useAuth();
  const gatewayIdParam = params?.gatewayId;
  const gatewayId = Array.isArray(gatewayIdParam)
    ? gatewayIdParam[0]
    : gatewayIdParam;

  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const initial = useMemo(() => defaultRange(), []);
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  // Applied range — only changes when "Apply" is pressed so we don't refetch on every keystroke.
  const [appliedRange, setAppliedRange] = useState(initial);

  const gatewayQuery = useGetGatewayApiV1GatewaysGatewayIdGet<
    getGatewayApiV1GatewaysGatewayIdGetResponse,
    ApiError
  >(gatewayId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gatewayId),
    },
  });

  const gateway =
    gatewayQuery.data?.status === 200 ? gatewayQuery.data.data : null;

  const costQuery = useUsageCostApiV1OpenclawGatewayIdUsageCostGet<
    usageCostApiV1OpenclawGatewayIdUsageCostGetResponse,
    ApiError
  >(
    gatewayId ?? "",
    { from: appliedRange.from, to: appliedRange.to },
    {
      query: {
        enabled: Boolean(isSignedIn && isAdmin && gatewayId),
        refetchInterval: 60_000,
      },
    },
  );

  const cost =
    costQuery.data?.status === 200 ? costQuery.data.data : null;
  const rows: UsageCostRow[] = useMemo(
    () => cost?.by_provider ?? [],
    [cost?.by_provider],
  );

  const maxRowCost = useMemo(() => {
    let max = 0;
    for (const row of rows) {
      const c = typeof row.cost_usd === "number" ? row.cost_usd : 0;
      if (c > max) max = c;
    }
    return max;
  }, [rows]);

  const totalCost = cost?.total_cost_usd ?? 0;

  const title = gateway?.name ? `${gateway.name} — Costs` : "Costs";

  const handleApply = () => {
    setAppliedRange({ from: fromDate, to: toDate });
  };

  const handleReset = () => {
    const next = defaultRange();
    setFromDate(next.from);
    setToDate(next.to);
    setAppliedRange(next);
  };

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to view gateway costs.",
        forceRedirectUrl: `/gateways/${gatewayId}/costs`,
      }}
      title={title}
      description="Per-provider token spend over the selected date range."
      headerActions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/gateways/${gatewayId}`)}
          >
            Back to gateway
          </Button>
        </div>
      }
      isAdmin={isAdmin}
      adminOnlyMessage="Only organization owners and admins can access gateway costs."
    >
      <div className="space-y-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Date range
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto_auto]">
            <div>
              <label className="text-xs uppercase text-slate-400" htmlFor="from">
                From
              </label>
              <Input
                id="from"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                max={toDate || undefined}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-400" htmlFor="to">
                To
              </label>
              <Input
                id="to"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                min={fromDate || undefined}
                className="mt-1"
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleApply}
                disabled={!fromDate || !toDate}
              >
                Apply
              </Button>
            </div>
            <div className="flex items-end">
              <Button variant="outline" onClick={handleReset}>
                Last 30 days
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Total cost
          </p>
          <div className="mt-3 flex flex-wrap items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums text-slate-900">
              {costQuery.isLoading ? "—" : formatUsd(totalCost)}
            </span>
            <span className="text-sm text-slate-500">
              {appliedRange.from} → {appliedRange.to}
            </span>
          </div>
          {cost?.range_start || cost?.range_end ? (
            <p className="mt-2 text-xs text-slate-500">
              Backend reported range:{" "}
              {cost.range_start ?? "—"} → {cost.range_end ?? "—"}
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              By provider
            </p>
            {costQuery.isLoading ? (
              <span className="text-xs text-slate-500">Loading…</span>
            ) : (
              <span className="text-xs text-slate-500">
                {rows.length} {rows.length === 1 ? "row" : "rows"}
              </span>
            )}
          </div>

          {costQuery.error ? (
            <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {costQuery.error.message}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-slate-500">
              {costQuery.isLoading
                ? "Loading cost rows…"
                : "No usage recorded in this date range."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="px-6 py-3">Provider</th>
                    <th className="px-6 py-3">Model</th>
                    <th className="px-6 py-3 text-right">Input</th>
                    <th className="px-6 py-3 text-right">Output</th>
                    <th className="px-6 py-3 text-right">Cache read</th>
                    <th className="px-6 py-3 text-right">Cache write</th>
                    <th className="px-6 py-3 text-right">Cost</th>
                    <th className="px-6 py-3 w-[200px]">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const rowCost =
                      typeof row.cost_usd === "number" ? row.cost_usd : 0;
                    const pct =
                      maxRowCost > 0 ? (rowCost / maxRowCost) * 100 : 0;
                    const key = `${row.provider ?? "?"}-${row.model ?? "?"}-${idx}`;
                    return (
                      <tr
                        key={key}
                        className="border-b border-slate-100 last:border-b-0"
                      >
                        <td className="px-6 py-3 font-medium text-slate-900">
                          {row.provider ?? "—"}
                        </td>
                        <td className="px-6 py-3 text-slate-700">
                          {row.model ?? "—"}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-slate-700">
                          {formatNumber(row.input_tokens)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-slate-700">
                          {formatNumber(row.output_tokens)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-slate-700">
                          {formatNumber(row.cache_read_tokens)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-slate-700">
                          {formatNumber(row.cache_write_tokens)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums font-medium text-slate-900">
                          {formatUsd(rowCost)}
                        </td>
                        <td className="px-6 py-3">
                          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 text-sm font-semibold text-slate-900">
                    <td className="px-6 py-3" colSpan={6}>
                      Total
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums">
                      {formatUsd(totalCost)}
                    </td>
                    <td className="px-6 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardPageLayout>
  );
}
