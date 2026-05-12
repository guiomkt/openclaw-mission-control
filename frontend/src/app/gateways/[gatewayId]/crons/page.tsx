"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { useAuth } from "@/auth/clerk";
import { useQueryClient } from "@tanstack/react-query";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { ApiError } from "@/api/mutator";
import {
  type listCronsApiV1OpenclawGatewayIdCronsGetResponse,
  type listCronRunsApiV1OpenclawGatewayIdCronsCronIdRunsGetResponse,
  getListCronsApiV1OpenclawGatewayIdCronsGetQueryKey,
  useAddCronApiV1OpenclawGatewayIdCronsPost,
  useListCronsApiV1OpenclawGatewayIdCronsGet,
  useListCronRunsApiV1OpenclawGatewayIdCronsCronIdRunsGet,
  useRemoveCronApiV1OpenclawGatewayIdCronsCronIdDelete,
  useRunCronApiV1OpenclawGatewayIdCronsCronIdRunPost,
  useUpdateCronApiV1OpenclawGatewayIdCronsCronIdPatch,
} from "@/api/generated/openclaw/openclaw";
import type {
  CronCreateRequest,
  CronEntry,
  CronMutateResponse,
  CronRunEntry,
  CronUpdateRequest,
} from "@/api/generated/model";
import { formatTimestamp, parseTimestamp } from "@/lib/formatters";
import { useOrganizationMembership } from "@/lib/use-organization-membership";

const RESTART_NOTICE =
  "Gateway restarted to apply config — table will refresh in a few seconds.";

function formatDuration(
  startedAt?: string | null,
  finishedAt?: string | null,
): string {
  const start = parseTimestamp(startedAt);
  const end = parseTimestamp(finishedAt);
  if (!start || !end) return "—";
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSec}s`;
}

type FormState = {
  name: string;
  schedule: string;
  target_agent: string;
  message: string;
  enabled: boolean;
};

const emptyForm: FormState = {
  name: "",
  schedule: "",
  target_agent: "",
  message: "",
  enabled: true,
};

type CronFormDialogProps = {
  open: boolean;
  mode: "create" | "edit";
  initialValues: FormState;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: FormState) => void;
};

function CronFormDialog({
  open,
  mode,
  initialValues,
  isSubmitting,
  errorMessage,
  onOpenChange,
  onSubmit,
}: CronFormDialogProps) {
  const [values, setValues] = useState<FormState>(initialValues);

  // Reset the form whenever it (re-)opens with a new set of initial values.
  // We key by `open` so we always rehydrate when the dialog appears.
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setValues(initialValues);
  }

  const handleChange = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(values);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={mode === "create" ? "New cron" : "Edit cron"}>
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New cron" : "Edit cron"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Schedule a recurring task on this gateway."
              : "Update this cron's schedule, target agent, or message."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label
              htmlFor="cron-name"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Name
            </label>
            <Input
              id="cron-name"
              value={values.name}
              onChange={(event) => handleChange("name", event.target.value)}
              placeholder="Optional friendly name"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="cron-schedule"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Schedule (cron expression)
              {mode === "create" ? (
                <span className="ml-1 text-rose-500">*</span>
              ) : null}
            </label>
            <Input
              id="cron-schedule"
              value={values.schedule}
              onChange={(event) => handleChange("schedule", event.target.value)}
              placeholder="0 8-20/2 * * 1-5"
              required={mode === "create"}
              spellCheck={false}
            />
            <p className="text-xs text-slate-500">
              Standard 5-field cron syntax. See{" "}
              <a
                href="https://crontab.guru/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-slate-700"
              >
                crontab.guru
              </a>{" "}
              for help.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="cron-target-agent"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Target agent
              {mode === "create" ? (
                <span className="ml-1 text-rose-500">*</span>
              ) : null}
            </label>
            <Input
              id="cron-target-agent"
              value={values.target_agent}
              onChange={(event) =>
                handleChange("target_agent", event.target.value)
              }
              placeholder="agent_slug"
              required={mode === "create"}
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="cron-message"
              className="block text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Message
            </label>
            <Textarea
              id="cron-message"
              value={values.message}
              onChange={(event) => handleChange("message", event.target.value)}
              placeholder="Message sent to the agent when this cron fires (optional)."
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
              checked={values.enabled}
              onChange={(event) =>
                handleChange("enabled", event.target.checked)
              }
            />
            <span>Enabled</span>
          </label>

          {errorMessage ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              {errorMessage}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create cron"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type RunsDialogProps = {
  open: boolean;
  gatewayId: string;
  cron: CronEntry | null;
  isSignedIn: boolean;
  isAdmin: boolean;
  onOpenChange: (open: boolean) => void;
};

function RunsDialog({
  open,
  gatewayId,
  cron,
  isSignedIn,
  isAdmin,
  onOpenChange,
}: RunsDialogProps) {
  const runsQuery = useListCronRunsApiV1OpenclawGatewayIdCronsCronIdRunsGet<
    listCronRunsApiV1OpenclawGatewayIdCronsCronIdRunsGetResponse,
    ApiError
  >(gatewayId, cron?.id ?? "", {
    query: {
      enabled: Boolean(open && isSignedIn && isAdmin && gatewayId && cron?.id),
      refetchInterval: open ? 15_000 : false,
    },
  });

  const runs: CronRunEntry[] = useMemo(() => {
    if (runsQuery.data?.status !== 200) return [];
    const items = runsQuery.data.data.runs ?? [];
    return items.slice(0, 20);
  }, [runsQuery.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Cron runs" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Recent runs{cron?.name ? ` — ${cron.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            Showing the last {runs.length || "20"} executions for this cron.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-slate-200 bg-white">
          {runsQuery.isLoading ? (
            <div className="p-6 text-sm text-slate-500">Loading runs…</div>
          ) : runsQuery.error ? (
            <div className="p-6 text-sm text-rose-700">
              {runsQuery.error.message}
            </div>
          ) : runs.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">No runs yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run, index) => (
                    <tr
                      key={run.id ?? `${run.started_at ?? "run"}-${index}`}
                      className="border-b border-slate-100 last:border-b-0"
                    >
                      <td className="px-4 py-3 text-slate-700">
                        {formatTimestamp(run.started_at)}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {run.status ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {formatDuration(run.started_at, run.finished_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CronsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useParams();
  const { isSignedIn } = useAuth();
  const gatewayIdParam = params?.gatewayId;
  const gatewayId = Array.isArray(gatewayIdParam)
    ? gatewayIdParam[0]
    : gatewayIdParam;

  const { isAdmin } = useOrganizationMembership(isSignedIn);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CronEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CronEntry | null>(null);
  const [runsTarget, setRunsTarget] = useState<CronEntry | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "info" | "error";
    message: string;
  } | null>(null);
  const [runningCronId, setRunningCronId] = useState<string | null>(null);
  const [togglingCronId, setTogglingCronId] = useState<string | null>(null);

  const cronsKey = gatewayId
    ? getListCronsApiV1OpenclawGatewayIdCronsGetQueryKey(gatewayId)
    : undefined;

  const cronsQuery = useListCronsApiV1OpenclawGatewayIdCronsGet<
    listCronsApiV1OpenclawGatewayIdCronsGetResponse,
    ApiError
  >(gatewayId ?? "", {
    query: {
      enabled: Boolean(isSignedIn && isAdmin && gatewayId),
      refetchInterval: 30_000,
    },
  });

  const crons = useMemo<CronEntry[]>(
    () =>
      cronsQuery.data?.status === 200
        ? (cronsQuery.data.data.crons ?? [])
        : [],
    [cronsQuery.data],
  );

  const invalidateCrons = () => {
    if (cronsKey) {
      void queryClient.invalidateQueries({ queryKey: cronsKey });
    }
  };

  const announceRestart = (response: CronMutateResponse | undefined) => {
    if (response?.restart_absorbed) {
      setFeedback({ tone: "info", message: RESTART_NOTICE });
      // Re-fetch after a short delay since the gateway is restarting.
      window.setTimeout(invalidateCrons, 4_000);
    }
  };

  const addMutation = useAddCronApiV1OpenclawGatewayIdCronsPost({
    mutation: {
      onSuccess: (response) => {
        if (response.status === 200) {
          announceRestart(response.data);
          invalidateCrons();
          setCreateOpen(false);
          setCreateError(null);
        } else {
          setCreateError("Failed to create cron — unexpected response.");
        }
      },
      onError: (err: ApiError) => {
        setCreateError(err.message);
      },
    },
  });

  const updateMutation = useUpdateCronApiV1OpenclawGatewayIdCronsCronIdPatch({
    mutation: {
      onSuccess: (response, variables) => {
        if (response.status === 200) {
          announceRestart(response.data);
          invalidateCrons();
          // If the toggle was the trigger, only clear toggling state.
          if (togglingCronId && togglingCronId === variables.cronId) {
            setTogglingCronId(null);
          }
          if (editTarget && editTarget.id === variables.cronId) {
            setEditTarget(null);
            setEditError(null);
          }
        } else {
          setEditError("Failed to update cron — unexpected response.");
          setTogglingCronId(null);
        }
      },
      onError: (err: ApiError) => {
        setEditError(err.message);
        setFeedback({ tone: "error", message: err.message });
        setTogglingCronId(null);
      },
    },
  });

  const removeMutation = useRemoveCronApiV1OpenclawGatewayIdCronsCronIdDelete({
    mutation: {
      onSuccess: (response) => {
        if (response.status === 200) {
          announceRestart(response.data);
          invalidateCrons();
          setDeleteTarget(null);
        } else {
          setFeedback({
            tone: "error",
            message: "Failed to delete cron — unexpected response.",
          });
        }
      },
      onError: (err: ApiError) => {
        setFeedback({ tone: "error", message: err.message });
      },
    },
  });

  const runMutation = useRunCronApiV1OpenclawGatewayIdCronsCronIdRunPost({
    mutation: {
      onSuccess: (response, variables) => {
        if (response.status === 200) {
          announceRestart(response.data);
          if (!response.data.restart_absorbed) {
            setFeedback({
              tone: "info",
              message: "Cron triggered.",
            });
          }
          invalidateCrons();
        } else {
          setFeedback({
            tone: "error",
            message: "Failed to run cron — unexpected response.",
          });
        }
        if (runningCronId === variables.cronId) {
          setRunningCronId(null);
        }
      },
      onError: (err: ApiError) => {
        setFeedback({ tone: "error", message: err.message });
        setRunningCronId(null);
      },
    },
  });

  const handleCreate = (values: FormState) => {
    if (!gatewayId) return;
    setCreateError(null);
    const data: CronCreateRequest = {
      schedule: values.schedule.trim(),
      target_agent: values.target_agent.trim(),
      enabled: values.enabled,
      ...(values.name.trim() ? { name: values.name.trim() } : {}),
      ...(values.message.trim() ? { message: values.message.trim() } : {}),
    };
    addMutation.mutate({ gatewayId, data });
  };

  const handleUpdate = (values: FormState) => {
    if (!gatewayId || !editTarget) return;
    setEditError(null);
    const data: CronUpdateRequest = {
      schedule: values.schedule.trim() || null,
      target_agent: values.target_agent.trim() || null,
      name: values.name.trim() || null,
      message: values.message.trim() || null,
      enabled: values.enabled,
    };
    updateMutation.mutate({
      gatewayId,
      cronId: editTarget.id,
      data,
    });
  };

  const handleToggle = (cron: CronEntry) => {
    if (!gatewayId) return;
    setTogglingCronId(cron.id);
    updateMutation.mutate({
      gatewayId,
      cronId: cron.id,
      data: { enabled: !(cron.enabled ?? false) },
    });
  };

  const handleRunNow = (cron: CronEntry) => {
    if (!gatewayId) return;
    setRunningCronId(cron.id);
    runMutation.mutate({ gatewayId, cronId: cron.id });
  };

  const handleDelete = () => {
    if (!gatewayId || !deleteTarget) return;
    removeMutation.mutate({ gatewayId, cronId: deleteTarget.id });
  };

  const editInitialValues: FormState = editTarget
    ? {
        name: editTarget.name ?? "",
        schedule: editTarget.schedule ?? "",
        target_agent: editTarget.target_agent ?? "",
        message: "",
        enabled: editTarget.enabled ?? true,
      }
    : emptyForm;

  return (
    <>
      <DashboardPageLayout
        signedOut={{
          message: "Sign in to view crons.",
          forceRedirectUrl: `/gateways/${gatewayId}/crons`,
        }}
        title="Crons"
        description="Scheduled tasks running on this gateway."
        headerActions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => router.push(`/gateways/${gatewayId}`)}
            >
              Back to gateway
            </Button>
            {isAdmin && gatewayId ? (
              <Button
                onClick={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
              >
                New cron
              </Button>
            ) : null}
          </div>
        }
        isAdmin={isAdmin}
        adminOnlyMessage="Only organization owners and admins can manage crons."
      >
        <div className="space-y-4">
          {feedback ? (
            <div
              className={
                feedback.tone === "error"
                  ? "flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
                  : "flex items-start justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800"
              }
            >
              <span>{feedback.message}</span>
              <button
                type="button"
                className="text-xs font-semibold uppercase tracking-wide"
                onClick={() => setFeedback(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Crons
              </p>
              {cronsQuery.isLoading ? (
                <span className="text-xs text-slate-500">Loading…</span>
              ) : (
                <span className="text-xs text-slate-500">
                  {crons.length} total
                </span>
              )}
            </div>
            {cronsQuery.isLoading ? (
              <div className="px-6 py-10 text-sm text-slate-500">
                Loading crons…
              </div>
            ) : cronsQuery.error ? (
              <div className="px-6 py-10 text-sm text-rose-700">
                {cronsQuery.error.message}
              </div>
            ) : crons.length === 0 ? (
              <div className="px-6 py-10 text-sm text-slate-500">
                No crons scheduled on this gateway yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <th className="px-6 py-3">Name</th>
                      <th className="px-6 py-3">Schedule</th>
                      <th className="px-6 py-3">Target agent</th>
                      <th className="px-6 py-3">Enabled</th>
                      <th className="px-6 py-3">Next run</th>
                      <th className="px-6 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crons.map((cron) => {
                      const enabled = cron.enabled ?? false;
                      const isToggling = togglingCronId === cron.id;
                      const isRunningNow = runningCronId === cron.id;
                      return (
                        <tr
                          key={cron.id}
                          className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                        >
                          <td className="px-6 py-4">
                            <div className="font-medium text-slate-900">
                              {cron.name ?? cron.id}
                            </div>
                            <div className="text-xs text-slate-500">
                              ID {cron.id}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <code className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-800">
                              {cron.schedule ?? "—"}
                            </code>
                          </td>
                          <td className="px-6 py-4 text-slate-700">
                            {cron.target_agent ?? "—"}
                          </td>
                          <td className="px-6 py-4">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={enabled}
                              aria-label={
                                enabled ? "Disable cron" : "Enable cron"
                              }
                              disabled={isToggling}
                              onClick={() => handleToggle(cron)}
                              className={
                                "relative inline-flex h-6 w-11 items-center rounded-full transition disabled:opacity-50 " +
                                (enabled ? "bg-emerald-500" : "bg-slate-300")
                              }
                            >
                              <span
                                className={
                                  "inline-block h-5 w-5 transform rounded-full bg-white shadow transition " +
                                  (enabled ? "translate-x-5" : "translate-x-0.5")
                                }
                              />
                            </button>
                          </td>
                          <td className="px-6 py-4 text-slate-700">
                            {formatTimestamp(cron.next_run)}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleRunNow(cron)}
                                disabled={isRunningNow}
                              >
                                {isRunningNow ? "Running…" : "Run now"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRunsTarget(cron)}
                              >
                                View runs
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setEditError(null);
                                  setEditTarget(cron);
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDeleteTarget(cron)}
                                className="border-rose-200 text-rose-700 hover:border-rose-400 hover:text-rose-800"
                              >
                                Delete
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </DashboardPageLayout>

      <CronFormDialog
        open={createOpen}
        mode="create"
        initialValues={emptyForm}
        isSubmitting={addMutation.isPending}
        errorMessage={createError}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setCreateError(null);
          }
        }}
        onSubmit={handleCreate}
      />

      <CronFormDialog
        open={!!editTarget}
        mode="edit"
        initialValues={editInitialValues}
        isSubmitting={updateMutation.isPending && !togglingCronId}
        errorMessage={editError}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null);
            setEditError(null);
          }
        }}
        onSubmit={handleUpdate}
      />

      <RunsDialog
        open={!!runsTarget}
        gatewayId={gatewayId ?? ""}
        cron={runsTarget}
        isSignedIn={Boolean(isSignedIn)}
        isAdmin={Boolean(isAdmin)}
        onOpenChange={(open) => {
          if (!open) setRunsTarget(null);
        }}
      />

      <ConfirmActionDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        ariaLabel="Delete cron"
        title="Delete cron"
        description={
          <>
            This will remove {deleteTarget?.name ?? deleteTarget?.id}. This
            action cannot be undone.
          </>
        }
        errorMessage={removeMutation.error?.message}
        onConfirm={handleDelete}
        isConfirming={removeMutation.isPending}
      />
    </>
  );
}
