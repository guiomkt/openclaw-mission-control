"use client";

/**
 * React context that mirrors the slice of Clerk's hook surface we depend on
 * — `useAuth`, `useUser`, plus signed-in/out predicate components — so the
 * existing `@/auth/clerk` shim can delegate to it without spreading
 * Supabase-aware code across every page.
 *
 * The session subscription lives here (not in the singleton client), because
 * React state ownership of "current session" needs to live in a component
 * tree to trigger re-renders.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { Session, User } from "@supabase/supabase-js";

import { getSupabaseBrowserClient } from "@/auth/supabaseClient";

interface SupabaseAuthValue {
  loaded: boolean;
  session: Session | null;
  user: User | null;
  /** Returns the current Supabase access JWT, or null if signed out. */
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const SupabaseAuthContext = createContext<SupabaseAuthValue | null>(null);

export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => getSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!client) {
      // Misconfigured — surface as signed-out instead of throwing during
      // build/prerender.
      setLoaded(true);
      return;
    }

    let unsubscribed = false;
    client.auth
      .getSession()
      .then(({ data }) => {
        if (unsubscribed) return;
        setSession(data.session);
      })
      .finally(() => {
        if (!unsubscribed) setLoaded(true);
      });

    const { data: sub } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      unsubscribed = true;
      sub.subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<SupabaseAuthValue>(
    () => ({
      loaded,
      session,
      user: session?.user ?? null,
      getToken: async () => {
        if (!client) return null;
        // Always re-read the live session: supabase-js refreshes the access
        // token in the background; the in-context `session` may be stale by
        // up to a few seconds.
        const { data } = await client.auth.getSession();
        return data.session?.access_token ?? null;
      },
      signOut: async () => {
        if (!client) return;
        await client.auth.signOut();
      },
    }),
    [client, loaded, session],
  );

  return (
    <SupabaseAuthContext.Provider value={value}>
      {children}
    </SupabaseAuthContext.Provider>
  );
}

export function useSupabaseAuth(): SupabaseAuthValue {
  const ctx = useContext(SupabaseAuthContext);
  if (ctx) return ctx;
  // Safe fallback for trees not wrapped (e.g. tests, prerender).
  return {
    loaded: true,
    session: null,
    user: null,
    getToken: async () => null,
    signOut: async () => {},
  };
}
