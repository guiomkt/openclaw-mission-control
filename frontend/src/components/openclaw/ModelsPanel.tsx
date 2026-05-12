"use client";

/**
 * Compact list of LLM models configured on the gateway, derived from
 * `models.list` RPC. Primary model is highlighted; fallbacks listed under it.
 */

import { useListModelsApiV1OpenclawGatewayIdModelsGet } from "@/api/generated/openclaw/openclaw";
import { ApiError } from "@/api/mutator";

type ModelsPanelProps = {
  gatewayId: string;
  enabled: boolean;
};

export function ModelsPanel({ gatewayId, enabled }: ModelsPanelProps) {
  const query = useListModelsApiV1OpenclawGatewayIdModelsGet<
    Awaited<
      ReturnType<
        typeof import("@/api/generated/openclaw/openclaw").listModelsApiV1OpenclawGatewayIdModelsGet
      >
    >,
    ApiError
  >(gatewayId, {
    query: { enabled: Boolean(enabled && gatewayId), refetchInterval: 60_000 },
  });

  const models =
    query.data?.status === 200 ? (query.data.data.models ?? []) : [];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Models
        </p>
        <span className="text-xs text-slate-500">
          {query.isLoading ? "Loading…" : `${models.length} configured`}
        </span>
      </div>
      {models.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          {query.isLoading ? "Fetching from gateway…" : "No models configured."}
        </p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between rounded-md border border-slate-100 px-3 py-2 text-sm"
            >
              <span className="truncate font-medium text-slate-800">
                {m.alias || m.id}
              </span>
              <div className="ml-2 flex shrink-0 items-center gap-2 text-xs">
                {m.primary ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">
                    primary
                  </span>
                ) : m.fallback ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">
                    fallback
                  </span>
                ) : null}
                <span className="text-slate-400">{m.id}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
