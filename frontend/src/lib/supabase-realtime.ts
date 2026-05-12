"use client";

/**
 * Supabase Realtime helpers — used as a *defense-in-depth* refresh trigger
 * for the candidate's own SSE streams.
 *
 * The candidate already streams task/approval/memory/agent updates via its
 * FastAPI SSE endpoints (`streamTasksApiV1...`, etc.). Those work great
 * when the user is actively viewing a board, but they're board-scoped.
 *
 * Supabase Realtime gives us a single org-wide event channel: any INSERT
 * into `public.activity_events` (from any backend worker, RQ job, CLI,
 * etc.) wakes the browser. We use it to:
 *   - invalidate the global Activity feed query so the dashboard refreshes
 *     within ~100ms instead of waiting for the next 15s poll;
 *   - surface drift events written by Phase E (drift_detector.py).
 *
 * The RLS policy added in migration `d2e7f4b5a1c0` scopes SELECT/Realtime
 * to authenticated users with a `users` row — no leak.
 */

import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/auth/supabaseClient";

type Options = {
  queryClient: QueryClient;
  /**
   * Query keys to invalidate on each Realtime event. The activity feed
   * query key prefix is the canonical caller — pass `["activity"]` (or
   * the orval-generated key) to refresh that view on every new event.
   */
  invalidateOnEvent: ReadonlyArray<ReadonlyArray<unknown>>;
  /** Disable the subscription (e.g. when not signed in). */
  enabled: boolean;
};

/**
 * Subscribe to `public.activity_events` INSERTs for the lifetime of the
 * component. Safe to call from any client component; no-ops on SSR.
 */
export function useActivityRealtime({
  queryClient,
  invalidateOnEvent,
  enabled,
}: Options): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const client = getSupabaseBrowserClient();
    if (!client) return;
    const channel = client
      .channel("realtime:public.activity_events")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activity_events" },
        () => {
          for (const key of invalidateOnEvent) {
            void queryClient.invalidateQueries({ queryKey: [...key] });
          }
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [enabled, queryClient, invalidateOnEvent]);
}
