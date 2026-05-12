"use client";

/**
 * Renders Telegram/WhatsApp/etc. account status from the gateway's
 * `channels.status` RPC. One row per channel, each with sub-rows for its
 * configured accounts (telegram bot tokens, whatsapp linked phones, etc.).
 *
 * Status semantics (per OpenClaw):
 *   - `connected=true`  → live transport open
 *   - `running=true`    → process is up but maybe still reconnecting
 *   - `configured=true` → credentials present in openclaw.json
 * We render a single dot per account: green = connected, amber = running
 * but not connected, red = configured but down, gray = not configured.
 */

import { useListRuntimeAgentsApiV1OpenclawGatewayIdAgentsGet as _unused } from "@/api/generated/openclaw/openclaw";
import { useChannelsStatusApiV1OpenclawGatewayIdChannelsGet } from "@/api/generated/openclaw/openclaw";
import { ApiError } from "@/api/mutator";

void _unused;

type ChannelsPanelProps = {
  gatewayId: string;
  enabled: boolean;
};

function dot(account: {
  connected?: boolean | null;
  running?: boolean | null;
  configured?: boolean | null;
}) {
  if (account.connected) return { color: "bg-emerald-500", label: "Online" };
  if (account.running) return { color: "bg-amber-500", label: "Connecting" };
  if (account.configured) return { color: "bg-rose-500", label: "Offline" };
  return { color: "bg-slate-300", label: "Not configured" };
}

export function ChannelsPanel({ gatewayId, enabled }: ChannelsPanelProps) {
  const query = useChannelsStatusApiV1OpenclawGatewayIdChannelsGet<
    Awaited<
      ReturnType<
        typeof import("@/api/generated/openclaw/openclaw").channelsStatusApiV1OpenclawGatewayIdChannelsGet
      >
    >,
    ApiError
  >(gatewayId, {
    query: { enabled: Boolean(enabled && gatewayId), refetchInterval: 15_000 },
  });

  const channels =
    query.data?.status === 200 ? (query.data.data.channels ?? []) : [];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Channels
        </p>
        <span className="text-xs text-slate-500">
          {query.isLoading
            ? "Loading…"
            : `${channels.length} configured`}
        </span>
      </div>
      {channels.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          {query.isLoading
            ? "Fetching channel state from gateway…"
            : "No channels configured on this gateway."}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {channels.map((ch) => (
            <div key={ch.channel}>
              <p className="mb-2 text-sm font-semibold capitalize text-slate-700">
                {ch.channel}
              </p>
              <ul className="space-y-1.5">
                {(ch.accounts ?? []).map((a) => {
                  const d = dot(a);
                  return (
                    <li
                      key={a.account_id ?? "default"}
                      className="flex items-center justify-between rounded-md border border-slate-100 px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${d.color}`}
                          aria-label={d.label}
                          title={d.label}
                        />
                        <span className="font-medium text-slate-800">
                          {a.account_id ?? "default"}
                        </span>
                        {a.label ? (
                          <span className="text-xs text-slate-500">
                            {a.label}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-xs text-slate-500">{d.label}</span>
                    </li>
                  );
                })}
                {(ch.accounts ?? []).length === 0 ? (
                  <li className="text-xs text-slate-400">
                    No accounts under this channel.
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
