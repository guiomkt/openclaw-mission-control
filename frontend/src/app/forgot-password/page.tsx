"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";

import { getSupabaseBrowserClient } from "@/auth/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function resolveSiteOrigin(): string {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase && envBase.length > 0) {
    return envBase.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

const SUCCESS_MESSAGE =
  "If that email is on file, we just sent a password-reset link. Check your inbox.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const cleanedEmail = email.trim();
    if (!cleanedEmail) return;

    setSubmitting(true);

    const client = getSupabaseBrowserClient();
    if (!client) {
      // Don't leak config state to the user — always show the same
      // success message so we don't reveal whether the address exists.
      console.error(
        "Supabase client not configured — cannot send password reset.",
      );
      setSubmitting(false);
      setSubmitted(true);
      return;
    }

    const { error: resetError } = await client.auth.resetPasswordForEmail(
      cleanedEmail,
      {
        redirectTo: `${resolveSiteOrigin()}/auth/reset`,
      },
    );

    if (resetError) {
      // Intentionally swallow the error in the UI — we don't want
      // attackers to enumerate which emails are registered.
      console.error("Password reset failed:", resetError);
    }

    setSubmitting(false);
    setSubmitted(true);
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
              Account
            </span>
            <div className="rounded-xl bg-[color:var(--accent-soft)] p-2 text-[color:var(--accent)]">
              <Mail className="h-5 w-5" />
            </div>
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-strong">
              Forgot password
            </h1>
            <p className="text-sm text-muted">
              Enter your email and we'll send you a link to reset your password.
            </p>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          {submitted ? (
            <div className="space-y-4">
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                {SUCCESS_MESSAGE}
              </p>
              <Link
                href="/sign-in"
                className="text-sm font-medium text-[color:var(--accent)] hover:underline"
              >
                Back to sign-in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="forgot-password-email"
                  className="text-xs font-semibold uppercase tracking-[0.08em] text-muted"
                >
                  Email
                </label>
                <Input
                  id="forgot-password-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="operator@example.com"
                  autoFocus
                  disabled={submitting}
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={submitting}
              >
                {submitting ? "Sending..." : "Send reset link"}
              </Button>
              <div className="pt-1 text-center">
                <Link
                  href="/sign-in"
                  className="text-sm font-medium text-[color:var(--accent)] hover:underline"
                >
                  Back to sign-in
                </Link>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
