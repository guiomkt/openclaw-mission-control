"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { getSupabaseBrowserClient } from "@/auth/supabaseClient";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * OAuth / magic-link callback handler.
 *
 * Supabase redirects here after the user clicks a sign-in link or
 * completes an OAuth flow. We exchange the URL `code` for a session
 * and forward to /dashboard on success.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const client = getSupabaseBrowserClient();
    if (!client) {
      setError(
        "Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and " +
          "NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
      return;
    }

    (async () => {
      const { error: exchangeError } = await client.auth.exchangeCodeForSession(
        window.location.href,
      );
      if (cancelled) return;

      if (exchangeError) {
        setError(exchangeError.message || "Could not complete sign-in.");
        return;
      }

      router.replace("/dashboard");
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-app px-4 py-10">
      <Card className="relative w-full max-w-lg animate-fade-in-up">
        <CardHeader className="space-y-2 border-b border-[color:var(--border)] pb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-strong">
            {error ? "Sign-in failed" : "Signing you in..."}
          </h1>
          <p className="text-sm text-muted">
            {error
              ? "We couldn't finish signing you in."
              : "Hold on while we complete the sign-in."}
          </p>
        </CardHeader>
        <CardContent className="pt-5">
          {error ? (
            <div className="space-y-4">
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
              <Link
                href="/sign-in"
                className="text-sm font-medium text-[color:var(--accent)] hover:underline"
              >
                Back to sign-in
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted">One moment...</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
