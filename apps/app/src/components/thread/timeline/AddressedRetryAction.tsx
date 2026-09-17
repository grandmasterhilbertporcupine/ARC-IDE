import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { sdk } from "@/lib/sdk";
import { appToast } from "@/components/ui/app-toast";

export function AddressedRetryAction({
  threadId,
  operationId,
}: {
  threadId: string;
  operationId: string;
}) {
  const retry = useMutation({
    mutationFn: () =>
      sdk.threads.experimental_retryAddressed({ threadId, operationId }),
    onSuccess: (result) => {
      if (result.delivery === "sent")
        appToast.success(
          result.experimental_addressed?.summary ?? "Addressed work resumed",
        );
    },
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={retry.isPending || retry.isSuccess}
          onClick={() => retry.mutate()}
        >
          {retry.isPending
            ? "Retrying…"
            : retry.isSuccess
              ? "Resumed"
              : "Retry saved Send"}
        </Button>
        <Link
          className="text-caption text-muted-foreground underline underline-offset-4"
          to="/plugins/arc/teams"
        >
          Agent and team setup
        </Link>
        <Link
          className="text-caption text-muted-foreground underline underline-offset-4"
          to="/settings/providers"
        >
          Provider setup
        </Link>
      </div>
      {retry.error ? (
        <p className="text-caption text-destructive" role="alert">
          {retry.error.message}
        </p>
      ) : null}
    </div>
  );
}
