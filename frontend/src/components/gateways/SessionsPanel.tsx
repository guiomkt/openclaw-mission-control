"use client";

/**
 * Renders the live session list returned by `gatewaysStatus` (the
 * `sessions: [...]` array, not just `sessions_count`).
 *
 * Sessions are grouped by the agent id parsed out of the session key
 * (`agent:<agent_id>:<kind>:<peer>`), so the operator sees a tidy
 * "per-agent inbox" view rather than 56 raw rows.
 *
 * Each row links to `/gateways/{gatewayId}/sessions/{sessionKey}` where the
 * transcript page (Phase B3) renders chat history + send-message.
 */

import { useMemo, useState } from "react";
import Link from "next/link";

type RawSession = {
  key?: string;
  kind?: string;
  chatType?: string;
  updatedAt?: number | string | null;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
};

type SessionsPanelProps = {
  gatewayId: string;
  sessions: object[] | null | undefined;
  isLoading?: boolean;
};

type ParsedSession = {
  key: string;
  agent: string;
  kind: string;
  peer: string;
  raw: RawSession;
};

/**
 * Parse `agent:<agent_id>:<rest>` keys. Anything else is bucketed under
 * "ungrouped" so unknown shapes don't get silently dropped.
 */
function parseKey(rawKey: string): { agent: string; kind: string; peer: string } {
  if (!rawKey.startsWith("agent:")) {
    return { agent: "ungrouped", kind: rawKey, peer: "" };
  }
  const body = rawKey.slice("agent:".length);
  const firstColon = body.indexOf(":");
  if (firstColon === -1) {
    return { agent: body, kind: "main", peer: "" };
  }
  const agent = body.slice(0, firstColon);
  const rest = body.slice(firstColon + 1);
  // `cron:<uuid>` and `whatsapp:direct:<peer>` and `telegram:topic:<n>` all
  // share the shape `<kind>:<peer>`. We split on the first colon to keep
  // the grouping (kind) readable even for nested forms.
  const innerColon = rest.indexOf(":");
  if (innerColon === -1) {
    return { agent, kind: rest, peer: "" };
  }
  return {
    agent,
    kind: rest.slice(0, innerColon),
    peer: rest.slice(innerColon + 1),
  };
}

function formatRelativeTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const ts = typeof value === "string" ? Date.parse(value) : value;
  if (!Number.isFinite(ts)) return "—";
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "future";
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}

export function SessionsPanel({
  gatewayId,
  sessions,
  isLoading,
}: SessionsPanelProps) {
  const [filter, setFilter] = useState("");

  const parsed = useMemo<ParsedSession[]>(() => {
    if (!sessions) return [];
    const out: ParsedSession[] = [];
    for (const item of sessions) {
      if (typeof item !== "object" || item === null) continue;
      const raw = item as RawSession;
      const key = typeof raw.key === "string" ? raw.key : null;
      if (!key) continue;
      const { agent, kind, peer } = parseKey(key);
      out.push({ key, agent, kind, peer, raw });
    }
    return out;
  }, [sessions]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return parsed;
    return parsed.filter(
      (s) =>
        s.key.toLowerCase().includes(f) ||
        s.agent.toLowerCase().includes(f) ||
        s.kind.toLowerCase().includes(f) ||
        s.peer.toLowerCase().includes(f),
    );
  }, [parsed, filter]);

  const grouped = useMemo(() => {
    const byAgent = new Map<string, ParsedSession[]>();
    for (const s of filtered) {
      const list = byAgent.get(s.agent) ?? [];
      list.push(s);
      byAgent.set(s.agent, list);
    }
    // Sort agents alphabetically but pin `main` to top.
    const agents = [...byAgent.keys()].sort((a, b) => {
      if (a === "main") return -1;
      if (b === "main") return 1;
      return a.localeCompare(b);
    });
    return agents.map((agent) => ({
      agent,
      sessions: byAgent.get(agent)!.sort((a, b) => {
        const aTs =
          typeof a.raw.updatedAt === "number"
            ? a.raw.updatedAt
            : Date.parse(String(a.raw.updatedAt));
        const bTs =
          typeof b.raw.updatedAt === "number"
            ? b.raw.updatedAt
            : Date.parse(String(b.raw.updatedAt));
        return (bTs || 0) - (aTs || 0);
      }),
    }));
  }, [filtered]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Sessions
        </p>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by agent, kind, peer…"
            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            aria-label="Filter sessions"
          />
          <span>
            {isLoading
              ? "Loading…"
              : `${filtered.length} of ${parsed.length} live`}
          </span>
        </div>
      </div>
      {isLoading && parsed.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">Fetching from gateway…</p>
      ) : grouped.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          {parsed.length === 0
            ? "No active sessions reported by the gateway."
            : "No sessions match the filter."}
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {grouped.map(({ agent, sessions: agentSessions }) => (
            <div key={agent}>
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="font-semibold text-slate-700">{agent}</span>
                <span className="text-slate-400">
                  · {agentSessions.length}{" "}
                  {agentSessions.length === 1 ? "session" : "sessions"}
                </span>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                {agentSessions.map(({ key, kind, peer, raw }) => (
                  <li key={key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                    <Link
                      href={`/gateways/${gatewayId}/sessions/${encodeURIComponent(key)}`}
                      className="flex min-w-0 flex-1 items-center gap-2"
                    >
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                        {kind || "session"}
                      </span>
                      <span className="truncate text-slate-700">
                        {peer || <span className="text-slate-400">main</span>}
                      </span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
                      {raw.totalTokens !== undefined ? (
                        <span title="Total tokens used">
                          {raw.totalTokens.toLocaleString()} tok
                        </span>
                      ) : null}
                      <span>{formatRelativeTime(raw.updatedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
