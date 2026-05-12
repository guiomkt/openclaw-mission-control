"use client";

import { useState } from "react";
import { Lock } from "lucide-react";

import { getSupabaseBrowserClient } from "@/auth/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Email/password sign-in for Supabase mode.
 *
 * Operator accounts are provisioned via the Supabase dashboard (Auth → Users
 * → Add user). Public signup is not exposed here on purpose — Mission Control
 * is a single-tenant operator panel; adding users is a deliberate ops action.
 */
type SupabaseLoginProps = {
  onAuthenticated?: () => void;
};

const defaultOnAuthenticated = () => window.location.reload();

export function SupabaseLogin({ onAuthenticated }: SupabaseLoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const client = getSupabaseBrowserClient();
    if (!client) {
      setError(
        "Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and " +
          "NEXT_PUBLIC_SUPABASE_ANON_KEY before signing in.",
      );
      return;
    }

    const cleanedEmail = email.trim();
    if (!cleanedEmail || !password) {
      setError("Email and password are required.");
      return;
    }

    setSubmitting(true);
    const { error: signInError } = await client.auth.signInWithPassword({
      email: cleanedEmail,
      password,
    });
    setSubmitting(false);

    if (signInError) {
      setError(signInError.message || "Sign-in failed.");
      return;
    }

    (onAuthenticated ?? defaultOnAuthenticated)();
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-app px-4 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-28 -left-24 h-72 w-72 rounded-full bg-[color:var(--accent-soft)] blur-3xl" />
        <div className="absolute -right-28 -bottom-24 h-80 w-80 rounded-full bg-[rgba(14,165,233,0.12)] blur-3xl" />
      </div>

      <Card className="relative w-full max-w-lg animate-fade-in-up">
        <CardHeader className="space-y-5 border-b border-[color:var(--border)] pb-5">
          <div className="flex items-center justify-between">
            <span className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              Supabase
            </span>
            <div className="rounded-xl bg-[color:var(--accent-soft)] p-2 text-[color:var(--accent)]">
              <Lock className="h-5 w-5" />
            </div>
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-strong">
              Sign in
            </h1>
            <p className="text-sm text-muted">
              Use your operator account from the Supabase dashboard.
            </p>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="supabase-email"
                className="text-xs font-semibold uppercase tracking-[0.08em] text-muted"
              >
                Email
              </label>
              <Input
                id="supabase-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="operator@example.com"
                autoFocus
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="supabase-password"
                className="text-xs font-semibold uppercase tracking-[0.08em] text-muted"
              >
                Password
              </label>
              <Input
                id="supabase-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />
            </div>
            {error ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={submitting}
            >
              {submitting ? "Signing in..." : "Continue"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
