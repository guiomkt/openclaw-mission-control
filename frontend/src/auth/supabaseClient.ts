"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Validity heuristic: anon keys are JWTs ~200 chars+, project URLs are
// https://<ref>.supabase.co. We don't want to accidentally instantiate a
// client with placeholder strings.
function isLikelyValidSupabaseConfig(
  url: string | undefined,
  anonKey: string | undefined,
): boolean {
  if (!url || !anonKey) return false;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) return false;
  if (anonKey.length < 100) return false;
  return true;
}

let cached: SupabaseClient | null = null;

/**
 * Singleton Supabase client for the browser. Returns `null` when the
 * env vars are missing or look like placeholders — call sites must
 * handle this gracefully (typically by treating the user as signed-out).
 *
 * The client persists sessions in `localStorage` by default. We keep
 * `autoRefreshToken: true` so long-lived sessions transparently roll
 * their access tokens before they expire.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!isLikelyValidSupabaseConfig(url, anonKey)) return null;

  cached = createClient(url!, anonKey!, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Use localStorage so the session survives full reloads, which is
      // important for the multi-tab operator workflow.
      storageKey: "mc_supabase_session",
    },
  });
  return cached;
}
