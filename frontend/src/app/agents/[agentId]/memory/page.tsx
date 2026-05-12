"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/auth/clerk";

import { ApiError } from "@/api/mutator";
import {
  type getAgentApiV1AgentsAgentIdGetResponse,
  useGetAgentApiV1AgentsAgentIdGet,
} from "@/api/generated/agents/agents";
import {
  type getAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNameGetResponse,
  type listAgentFilesApiV1OpenclawGatewayIdAgentsAgentIdFilesGetResponse,
  getGetAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNameGetQueryKey,
  useGetAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNameGet,
  useListAgentFilesApiV1OpenclawGatewayIdAgentsAgentIdFilesGet,
  useSetAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNamePut,
} from "@/api/generated/openclaw/openclaw";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatTimestamp } from "@/lib/formatters";
import { useOrganizationMembership } from "@/lib/use-organization-membership";

const formatBytes = (size?: number | null) => {
  if (typeof size !== "number") return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export default function AgentMemoryPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useParams();
  const { isSignedIn } = useAuth();
  const agentIdParam = params?.agentId;
  const agentId = Array.isArray(agentIdParam) ? agentIdParam[0] : agentIdParam;

  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // The draft holds the textarea value. `loadedKey` tracks which file/version
  // the draft was last seeded from, so we can detect when fresh content
  // arrives and re-seed without using setState-in-useEffect.
  const [draft, setDraft] = useState<string>("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const agentQuery = useGetAgentApiV1AgentsAgentIdGet<
    getAgentApiV1AgentsAgentIdGetResponse,
    ApiError
  >(agentId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && agentId),
      refetchOnMount: "always",
      retry: false,
    },
  });

  const agent =
    agentQuery.data?.status === 200 ? agentQuery.data.data : null;
  const gatewayId = agent?.gateway_id ?? "";

  const filesQuery = useListAgentFilesApiV1OpenclawGatewayIdAgentsAgentIdFilesGet<
    listAgentFilesApiV1OpenclawGatewayIdAgentsAgentIdFilesGetResponse,
    ApiError
  >(gatewayId, agentId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gatewayId && agentId),
      refetchInterval: 30_000,
    },
  });

  const filesPayload =
    filesQuery.data?.status === 200 ? filesQuery.data.data : null;
  const files = useMemo(() => filesPayload?.files ?? [], [filesPayload]);

  // Auto-select first file if nothing selected yet. Derived during render
  // rather than via useEffect so we avoid the cascading-render lint rule.
  const effectiveSelected = selectedFile ?? files[0]?.name ?? null;

  const fileQuery =
    useGetAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNameGet<
      getAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNameGetResponse,
      ApiError
    >(gatewayId, agentId ?? "", effectiveSelected ?? "", {
      query: {
        enabled: Boolean(
          isSignedIn && isAdmin && gatewayId && agentId && effectiveSelected,
        ),
        refetchOnMount: "always",
      },
    });

  const fileContent =
    fileQuery.data?.status === 200 ? fileQuery.data.data : null;

  // Seed the textarea draft when fresh content arrives for the current file.
  // dataUpdatedAt changes on every refetch so a Reload also re-seeds.
  const contentKey =
    fileContent && fileContent.name === effectiveSelected
      ? `${effectiveSelected}:${fileQuery.dataUpdatedAt}`
      : null;
  if (contentKey && contentKey !== loadedKey) {
    setLoadedKey(contentKey);
    setDraft(fileContent?.content ?? "");
    if (saveError) setSaveError(null);
  }

  const saveMutation =
    useSetAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNamePut<ApiError>(
      {
        mutation: {
          onSuccess: (response) => {
            if (response.status === 200) {
              setSaveError(null);
              setSavedAt(new Date().toISOString());
              void queryClient.invalidateQueries({
                queryKey: ["/api/v1/openclaw", gatewayId, "agents"],
                exact: false,
              });
              if (effectiveSelected) {
                void queryClient.invalidateQueries({
                  queryKey:
                    getGetAgentFileApiV1OpenclawGatewayIdAgentsAgentIdFilesFileNameGetQueryKey(
                      gatewayId,
                      agentId ?? "",
                      effectiveSelected,
                    ),
                });
              }
            } else {
              setSaveError("Save returned an unexpected response.");
            }
          },
          onError: (err) => {
            setSaveError(err.message || "Save failed.");
          },
        },
      },
    );

  const handleSelect = (name: string) => {
    if (name === effectiveSelected) return;
    setSelectedFile(name);
    setSaveError(null);
    setSavedAt(null);
    setLoadedKey(null);
    setDraft("");
  };

  const handleSave = () => {
    if (!gatewayId || !agentId || !effectiveSelected) return;
    setSaveError(null);
    saveMutation.mutate({
      gatewayId,
      agentId,
      fileName: effectiveSelected,
      data: { content: draft },
    });
  };

  const handleReload = () => {
    setSaveError(null);
    setSavedAt(null);
    void fileQuery.refetch();
  };

  const title = agent?.name ? `${agent.name} — Memory` : "Memory editor";
  const fileError = fileQuery.error?.message ?? null;
  const filesError = filesQuery.error?.message ?? null;
  const isSaving = saveMutation.isPending;
  const isFileLoading = fileQuery.isLoading || fileQuery.isFetching;

  return (
    <DashboardPageLayout
      signedOut={{
        message: "Sign in to edit agent memory.",
        forceRedirectUrl: `/agents/${agentId}/memory`,
      }}
      title={title}
      description="Edit the agent's workspace memory files directly."
      headerActions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/agents/${agentId}`)}
          >
            Back to agent
          </Button>
        </div>
      }
      isAdmin={isAdmin}
      adminOnlyMessage="Only organization owners and admins can edit agent memory."
    >
      {agentQuery.isLoading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Loading agent…
        </div>
      ) : agentQuery.error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
          {agentQuery.error.message}
        </div>
      ) : !agent ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Agent not found.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Files
              </p>
              {filesQuery.isLoading ? (
                <span className="text-xs text-slate-500">Loading…</span>
              ) : (
                <span className="text-xs text-slate-500">{files.length}</span>
              )}
            </div>
            {filesPayload?.workspace ? (
              <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
                <span className="uppercase tracking-wide text-slate-400">
                  Workspace
                </span>
                <span className="ml-1 break-all text-slate-700">
                  {filesPayload.workspace}
                </span>
              </p>
            ) : null}
            {filesError ? (
              <div className="m-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                {filesError}
              </div>
            ) : files.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-500">
                {filesQuery.isLoading ? "Loading files…" : "No files yet."}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {files.map((file) => {
                  const active = file.name === effectiveSelected;
                  return (
                    <li key={file.name}>
                      <button
                        type="button"
                        onClick={() => handleSelect(file.name)}
                        className={`block w-full px-4 py-3 text-left transition ${
                          active
                            ? "bg-emerald-50"
                            : "bg-white hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`truncate text-sm font-medium ${
                              active ? "text-emerald-700" : "text-slate-900"
                            }`}
                          >
                            {file.name}
                          </span>
                          {file.missing ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                              Missing
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                          <span>{formatBytes(file.size)}</span>
                          <span>{formatTimestamp(file.updated_at)}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {effectiveSelected ? "Editing" : "No file selected"}
                </p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {effectiveSelected ?? "Pick a file from the list"}
                </p>
                {fileContent ? (
                  <p className="mt-1 text-xs text-slate-500">
                    {formatBytes(fileContent.size)}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handleReload}
                  disabled={!effectiveSelected || isFileLoading}
                >
                  {isFileLoading ? "Loading…" : "Reload"}
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!effectiveSelected || isSaving || isFileLoading}
                >
                  {isSaving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>

            {saveError ? (
              <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                {saveError}
              </div>
            ) : null}
            {savedAt && !saveError ? (
              <div className="m-6 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                Saved {formatTimestamp(savedAt)}.
              </div>
            ) : null}
            {fileError ? (
              <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                {fileError}
              </div>
            ) : null}

            <div className="p-6">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={!effectiveSelected || isFileLoading}
                placeholder={
                  effectiveSelected
                    ? "File contents…"
                    : "Select a file on the left to edit."
                }
                spellCheck={false}
                className="min-h-[480px] font-mono text-sm leading-relaxed"
              />
            </div>
          </section>
        </div>
      )}
    </DashboardPageLayout>
  );
}
