"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { useAuth } from "@/auth/clerk";
import { useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/api/mutator";
import {
  getGetSessionHistoryApiV1GatewaysSessionsSessionIdHistoryGetQueryKey,
  useGetGatewaySessionApiV1GatewaysSessionsSessionIdGet,
  useGetSessionHistoryApiV1GatewaysSessionsSessionIdHistoryGet,
  useSendGatewaySessionMessageApiV1GatewaysSessionsSessionIdMessagePost,
} from "@/api/generated/gateways/gateways";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Button } from "@/components/ui/button";
import { useOrganizationMembership } from "@/lib/use-organization-membership";

/**
 * Per-session transcript page.
 *
 * Renders the chat history (`chat.history` RPC) for a single session key and
 * lets the operator post messages as the human-in-the-loop via the
 * `chat.send` RPC. The page scopes by `gateway_id` (not `board_id`) so it
 * works for sessions on imported agents that haven't been attached to a
 * board yet.
 */
export default function SessionTranscriptPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useParams();
  const { isSignedIn } = useAuth();
  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const gatewayId = Array.isArray(params?.gatewayId)
    ? params.gatewayId[0]
    : (params?.gatewayId as string | undefined);
  const rawSessionKey = Array.isArray(params?.sessionKey)
    ? params.sessionKey[0]
    : (params?.sessionKey as string | undefined);
  const sessionKey = useMemo(
    () => (rawSessionKey ? decodeURIComponent(rawSessionKey) : ""),
    [rawSessionKey],
  );

  const enabled = Boolean(isSignedIn && isAdmin && gatewayId && sessionKey);

  const sessionMetaQuery =
    useGetGatewaySessionApiV1GatewaysSessionsSessionIdGet<
      Awaited<
        ReturnType<
          typeof import("@/api/generated/gateways/gateways").getGatewaySessionApiV1GatewaysSessionsSessionIdGet
        >
      >,
      ApiError
    >(sessionKey, gatewayId ? { gateway_id: gatewayId } : undefined, {
      query: {
        enabled,
        refetchInterval: 30_000,
      },
    });

  const historyQuery =
    useGetSessionHistoryApiV1GatewaysSessionsSessionIdHistoryGet<
      Awaited<
        ReturnType<
          typeof import("@/api/generated/gateways/gateways").getSessionHistoryApiV1GatewaysSessionsSessionIdHistoryGet
        >
      >,
      ApiError
    >(sessionKey, gatewayId ? { gateway_id: gatewayId } : undefined, {
      query: {
        enabled,
        refetchInterval: 10_000,
      },
    });

  const historyKey = useMemo(
    () =>
      getGetSessionHistoryApiV1GatewaysSessionsSessionIdHistoryGetQueryKey(
        sessionKey,
        gatewayId ? { gateway_id: gatewayId } : undefined,
      ),
    [sessionKey, gatewayId],
  );

  const sendMutation =
    useSendGatewaySessionMessageApiV1GatewaysSessionsSessionIdMessagePost<ApiError>({
      mutation: {
        onSuccess: () => {
          setDraft("");
          // After a successful send, the gateway typically takes a few seconds
          // to write the new entry to `chat.history`. Invalidate after a small
          // delay rather than immediately so the next refetch picks it up.
          window.setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: historyKey });
          }, 1500);
        },
      },
    });

  const [draft, setDraft] = useState("");
  const messages = useMemo(() => {
    if (historyQuery.data?.status !== 200) return [];
    const raw = historyQuery.data.data.history ?? [];
    return raw as Array<Record<string, unknown>>;
  }, [historyQuery.data]);

  const sessionMeta =
    sessionMetaQuery.data?.status === 200
      ? (sessionMetaQuery.data.data.session as Record<string, unknown> | null | undefined)
      : null;

  // Auto-scroll to the latest message on update.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed || !sessionKey || !gatewayId) return;
    sendMutation.mutate({
      sessionId: sessionKey,
      data: { content: trimmed },
      params: { gateway_id: gatewayId },
    });
  };

  const title = sessionKey || "Session";

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to view a session.",
        forceRedirectUrl: `/gateways/${gatewayId}/sessions/${rawSessionKey ?? ""}`,
      }}
      title={title}
      description="Live OpenClaw session — transcript + send a message as operator."
      headerActions={
        <Button
          variant="outline"
          onClick={() => router.push(`/gateways/${gatewayId}`)}
        >
          Back to gateway
        </Button>
      }
      isAdmin={isAdmin}
      adminOnlyMessage="Only organization owners and admins can view sessions."
    >
      <div className="space-y-4">
        {sessionMeta ? (
          <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm sm:grid-cols-3">
            <div>
              <p className="uppercase text-slate-400">Kind</p>
              <p className="mt-0.5 text-sm text-slate-900">
                {(sessionMeta.kind as string) || "—"}
              </p>
            </div>
            <div>
              <p className="uppercase text-slate-400">Total tokens</p>
              <p className="mt-0.5 text-sm text-slate-900">
                {(sessionMeta.totalTokens as number | undefined)?.toLocaleString() ?? "—"}
              </p>
            </div>
            <div>
              <p className="uppercase text-slate-400">Session id</p>
              <p className="mt-0.5 truncate text-sm text-slate-900">
                {(sessionMeta.sessionId as string) || "—"}
              </p>
            </div>
          </div>
        ) : null}

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Transcript{" "}
            {historyQuery.isFetching ? (
              <span className="ml-2 text-slate-400">(refreshing…)</span>
            ) : null}
          </div>
          <div
            ref={scrollerRef}
            className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-4"
          >
            {historyQuery.isLoading ? (
              <p className="text-sm text-slate-500">Fetching history…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-slate-500">
                No messages in this session yet.
              </p>
            ) : (
              messages.map((msg, idx) => {
                const role = String(msg.role ?? msg.from ?? "agent");
                const content =
                  typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content ?? msg.text ?? msg);
                const isOperator =
                  role === "user" || role === "operator" || role === "human";
                return (
                  <div
                    key={String(msg.id ?? idx)}
                    className={`flex ${isOperator ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                        isOperator
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-slate-100 text-slate-800"
                      }`}
                    >
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {role}
                      </p>
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                        {content}
                      </pre>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-slate-200 px-4 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="flex items-end gap-2"
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Send a message as operator…"
                rows={3}
                className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits without manually clicking.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <Button
                type="submit"
                disabled={sendMutation.isPending || draft.trim().length === 0}
              >
                {sendMutation.isPending ? "Sending…" : "Send"}
              </Button>
            </form>
            {sendMutation.error ? (
              <p className="mt-2 text-xs text-rose-600">
                {sendMutation.error.message}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </DashboardPageLayout>
  );
}
