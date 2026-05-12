"use client";

/**
 * Renders a "Drift detected" banner when the gateway's runtime agents
 * differ from what mc-v2's `agents` table believes. Lets the operator
 * re-scan or jump to the Discover button.
 *
 * Data source: `GET /api/v1/openclaw/{gateway_id}/drift` (read-only, fast).
 * Backed by activity_events entries written by drift_detector.py every
 * ~5 minutes. We don't poll the read endpoint aggressively — the
 * Realtime channel (D2) already wakes the page when new activity_events
 * land, so 60s refetch is plenty.
 */

import {
  useGetDriftStatusApiV1OpenclawGatewayIdDriftGet,
  useScanDriftApiV1OpenclawGatewayIdDriftScanPost,
} from "@/api/generated/openclaw/openclaw";
import { ApiError } from "@/api/mutator";
import { Button } from "@/components/ui/button";

type DriftBannerProps = {
  gatewayId: string;
  enabled: boolean;
  onResolveClick?: () => void;
};

export function DriftBanner({
  gatewayId,
  enabled,
  onResolveClick,
}: DriftBannerProps) {
  const query = useGetDriftStatusApiV1OpenclawGatewayIdDriftGet<
    Awaited<
      ReturnType<
        typeof import("@/api/generated/openclaw/openclaw").getDriftStatusApiV1OpenclawGatewayIdDriftGet
      >
    >,
    ApiError
  >(gatewayId, {
    query: { enabled: Boolean(enabled && gatewayId), refetchInterval: 60_000 },
  });
  const scanMutation =
    useScanDriftApiV1OpenclawGatewayIdDriftScanPost<ApiError>();

  const drift =
    query.data?.status === 200 ? (query.data.data.drift ?? null) : null;

  // No drift detected or detector hasn't run yet → render nothing.
  if (!drift) return null;
  const runtimeOnly = drift.in_runtime_only ?? [];
  const dbOnly = drift.in_db_only ?? [];
  if (runtimeOnly.length === 0 && dbOnly.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Drift detected between mc-v2 and gateway runtime</p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {runtimeOnly.length > 0 ? (
              <li>
                <span className="font-medium">{runtimeOnly.length}</span> agent{runtimeOnly.length === 1 ? "" : "s"}{" "}
                on the gateway not yet in mc-v2: {runtimeOnly.slice(0, 5).join(", ")}
                {runtimeOnly.length > 5 ? "…" : ""}
              </li>
            ) : null}
            {dbOnly.length > 0 ? (
              <li>
                <span className="font-medium">{dbOnly.length}</span> mc-v2 row{dbOnly.length === 1 ? "" : "s"}{" "}
                missing from the gateway: {dbOnly.slice(0, 5).join(", ")}
                {dbOnly.length > 5 ? "…" : ""}
              </li>
            ) : null}
          </ul>
          {drift.detected_at ? (
            <p className="mt-2 text-xs text-amber-700">
              Detected {new Date(drift.detected_at).toLocaleString()}.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button
            variant="outline"
            onClick={() => {
              scanMutation.mutate(
                { gatewayId },
                {
                  onSettled: () => {
                    void query.refetch();
                  },
                },
              );
            }}
            disabled={scanMutation.isPending}
          >
            {scanMutation.isPending ? "Re-scanning…" : "Re-scan now"}
          </Button>
          {onResolveClick ? (
            <Button onClick={onResolveClick}>Discover & import</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
