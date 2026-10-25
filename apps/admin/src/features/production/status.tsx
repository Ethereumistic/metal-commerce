import type { ReactNode } from "react";
import { AlertTriangle, CloudOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";
import type {
  BatchStatus,
  JobStatus,
  PreparationStatus,
  ServiceError,
  ServiceResult,
} from "./contracts";

// Small presentational pieces shared across the Production workspace.

export const OFFLINE_TITLE = "Local processing service offline";

const PREPARATION_LABELS: Record<PreparationStatus, string> = {
  unprepared: "Not prepared",
  queued: "Queued",
  processing: "Tracing",
  ready: "Master ready",
  failed: "Failed",
  stale: "Stale master",
};

const tone = {
  neutral: "outline",
  busy: "secondary",
  good: "default",
  bad: "destructive",
} as const;

export function PreparationBadge({ status }: { status: PreparationStatus | null }) {
  if (!status) return <Badge variant="outline">Status unknown</Badge>;
  const variant =
    status === "ready"
      ? tone.good
      : status === "failed" || status === "stale"
        ? tone.bad
        : status === "unprepared"
          ? tone.neutral
          : tone.busy;
  return <Badge variant={variant}>{PREPARATION_LABELS[status]}</Badge>;
}

export function JobBadge({ status }: { status: JobStatus }) {
  const variant =
    status === "succeeded"
      ? tone.good
      : status === "failed"
        ? tone.bad
        : status === "cancelled"
          ? tone.neutral
          : tone.busy;
  return <Badge variant={variant}>{status}</Badge>;
}

export function BatchBadge({ status }: { status: BatchStatus }) {
  const variant =
    status === "completed"
      ? tone.good
      : status === "failed" || status === "invalid" || status === "incomplete"
        ? tone.bad
        : status === "draft" || status === "cancelled"
          ? tone.neutral
          : tone.busy;
  return <Badge variant={variant}>{status}</Badge>;
}

export function ErrorText({ error, className }: { error: ServiceError; className?: string }) {
  return (
    <p className={cn("text-xs text-destructive", className)}>
      <span className="font-mono">{error.code}</span> · {error.message}
    </p>
  );
}

export function OfflineAlert({ children }: { children?: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CloudOff />
      <AlertTitle>{OFFLINE_TITLE}</AlertTitle>
      <AlertDescription>
        {children ??
          "The admin could not reach the artwork service on the workshop PC. Nothing new was queued. Jobs already accepted keep running and appear here once it is back."}
      </AlertDescription>
    </Alert>
  );
}

/** Renders a failed result: the offline notice, or the service's error. */
export function ResultAlert({
  result,
  title,
}: {
  result: ServiceResult<unknown> | null;
  title: string;
}) {
  if (!result || result.ok) return null;
  if (result.offline) return <OfflineAlert />;
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <span className="font-mono">{result.error.code}</span> · {result.error.message}
      </AlertDescription>
    </Alert>
  );
}

export function formatMm(value: number) {
  return `${Number(value.toFixed(2))}`;
}

export function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
