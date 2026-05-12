"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { useEffect, type ReactNode } from "react";

import { isLikelyValidClerkPublishableKey } from "@/auth/clerkKey";
import {
  clearLocalAuthToken,
  getLocalAuthToken,
  isLocalAuthMode,
  isSupabaseAuthMode,
} from "@/auth/localAuth";
import {
  SupabaseAuthProvider,
  useSupabaseAuth,
} from "@/auth/SupabaseAuthContext";
import { LocalAuthLogin } from "@/components/organisms/LocalAuthLogin";
import { SupabaseLogin } from "@/components/organisms/SupabaseLogin";

/**
 * Internal gate: render `<SupabaseLogin />` until we have a live session,
 * otherwise pass the children through. Kept inside the provider so the
 * session subscription powers both the gate and the downstream hooks.
 */
function SupabaseAuthGate({ children }: { children: ReactNode }) {
  const { loaded, session } = useSupabaseAuth();
  if (!loaded) return null; // initial getSession() in flight
  if (!session) return <SupabaseLogin />;
  return <>{children}</>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const localMode = isLocalAuthMode();
  const supabaseMode = isSupabaseAuthMode();

  useEffect(() => {
    if (!localMode) {
      clearLocalAuthToken();
    }
  }, [localMode]);

  if (localMode) {
    if (!getLocalAuthToken()) {
      return <LocalAuthLogin />;
    }
    return <>{children}</>;
  }

  if (supabaseMode) {
    return (
      <SupabaseAuthProvider>
        <SupabaseAuthGate>{children}</SupabaseAuthGate>
      </SupabaseAuthProvider>
    );
  }

  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const afterSignOutUrl =
    process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_OUT_URL ?? "/";

  if (!isLikelyValidClerkPublishableKey(publishableKey)) {
    return <>{children}</>;
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      afterSignOutUrl={afterSignOutUrl}
    >
      {children}
    </ClerkProvider>
  );
}
