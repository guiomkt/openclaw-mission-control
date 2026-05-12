"use client";

/**
 * Open-on-demand drawer that streams the gateway's live log tail via SSE.
 *
 * Backend endpoint: `GET /api/v1/openclaw/{gateway_id}/logs/stream?lines=200&follow=true`
 * Mediatype: text/event-stream. Each `data:` event is one log entry (JSON).
 *
 * EventSource is opened lazily on first open() so the WS-bridge on the
 * backend doesn't stay alive when nobody's watching. The drawer keeps a
 * rolling buffer of the last 500 entries to bound memory.
 */

import { useEffect, useRef, useState } from "react";

import { getApiBaseUrl } from "@/lib/api-base";
import { Button } from "@/components/ui/button";

const MAX_ENTRIES = 500;

type LogEntry = {
  time?: string;
  level?: string;
  msg?: string;
  [k: string]: unknown;
};

type LogsDrawerProps = {
  gatewayId: string;
  /**
   * Supabase access token, lifted up by the parent because EventSource
   * doesn't support custom headers natively — we'd have to use a polyfill
   * or pass via query string. Backend route accepts only Bearer though, so
   * we use the cookie set by Next's same-origin proxy: in browser context
   * the SSE request inherits credentials, and the FastAPI route reads the
   * Authorization header from the mutator's fetch interceptor.
   *
   * Since EventSource bypasses fetch, we use `?token=` query as a
   * workaround. The backend should accept this for SSE endpoints only.
   * (Not implemented yet — for now we use the fetch+ReadableStream path.)
   */
};

function LevelDot({ level }: { level?: string }) {
  const colors: Record<string, string> = {
    error: "bg-rose-500",
    warn: "bg-amber-500",
    info: "bg-emerald-500",
    debug: "bg-slate-400",
  };
  const c = colors[(level ?? "info").toLowerCase()] ?? "bg-slate-300";
  return (
    <span
      className={`mr-2 inline-block h-2 w-2 rounded-full ${c}`}
      aria-label={level}
    />
  );
}

export function LogsDrawer({ gatewayId }: LogsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setEntries([]);
    setError(null);
    // EventSource doesn't allow headers. Use fetch with ReadableStream
    // (same-origin → auth cookie/bearer from the mutator's fetch wrapper
    // would be ideal, but we're constructing fetch manually here; rely on
    // the customFetch's Bearer injection via window.Clerk/supabase
    // hooks). Simpler: read the supabase access_token from the same place
    // mutator.ts reads it.
    (async () => {
      try {
        // Import lazily to avoid SSR issues.
        const { getSupabaseBrowserClient } = await import(
          "@/auth/supabaseClient"
        );
        const client = getSupabaseBrowserClient();
        let token: string | null = null;
        if (client) {
          const { data } = await client.auth.getSession();
          token = data.session?.access_token ?? null;
        }
        const baseUrl = getApiBaseUrl();
        const url = `${baseUrl}/api/v1/openclaw/${gatewayId}/logs/stream?lines=200&follow=true`;
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!resp.ok || !resp.body) {
          setError(`Stream failed: HTTP ${resp.status}`);
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        // SSE framing: each event ends with a blank line. Each event is one
        // or more lines starting with `data:` or `event:`.
        // We accumulate, split on \n\n, and process each event block.
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            // Look for the data: line, ignore comments and event: lines.
            const dataLine = raw
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            try {
              const entry = JSON.parse(payload) as LogEntry;
              setEntries((prev) => {
                const next = [...prev, entry];
                if (next.length > MAX_ENTRIES) {
                  next.splice(0, next.length - MAX_ENTRIES);
                }
                return next;
              });
            } catch {
              // ignore unparseable lines
            }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [open, gatewayId]);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen((v) => !v)}>
        {open ? "Close logs" : "View logs"}
      </Button>
      {open ? (
        <div className="fixed bottom-0 left-0 right-0 z-50 h-[40vh] border-t border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-sm">
            <p className="font-semibold text-slate-700">
              Gateway logs — live tail
            </p>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>{entries.length} entries</span>
              {error ? <span className="text-rose-600">{error}</span> : null}
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
          </div>
          <div className="h-[calc(40vh-2.5rem)] overflow-y-auto px-4 py-2 font-mono text-xs">
            {entries.length === 0 ? (
              <p className="text-slate-500">Waiting for log entries…</p>
            ) : (
              entries.map((e, i) => (
                <div key={i} className="flex">
                  <LevelDot level={e.level} />
                  <span className="mr-2 shrink-0 text-slate-400">
                    {e.time ?? ""}
                  </span>
                  <span className="whitespace-pre-wrap break-all text-slate-800">
                    {e.msg ?? JSON.stringify(e)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
