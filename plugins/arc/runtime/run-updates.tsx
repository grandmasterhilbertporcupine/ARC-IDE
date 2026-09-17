import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import type { z } from "zod";
import { errorMessage } from "../studio/data.js";
import type { InstructionUpdateApplication } from "./instruction-update-contract.js";
import {
  arcRuleUpdatesRpcContract,
  type RuleUpdateApplication,
} from "./rule-update-contract.js";

type UpdateState = z.infer<
  typeof arcRuleUpdatesRpcContract.getRunUpdateState.output
>;
type UpdateEntry = NonNullable<UpdateState["outgoing"]>;

export function useRunUpdates(runId: string, enabled: boolean) {
  const rpc = useRpc<typeof arcRuleUpdatesRpcContract>();
  const [data, setData] = useState<UpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const result = await rpc.call("getRunUpdateState", { runId });
      if (current === generation.current) {
        setData(result);
        setError(null);
      }
    } catch (failure) {
      if (current === generation.current) setError(errorMessage(failure));
    }
  }, [rpc, runId, enabled]);
  useEffect(() => {
    setData(null);
    setError(null);
    void refresh();
    const timer = enabled
      ? setInterval(() => {
          if (document.visibilityState === "visible") void refresh();
        }, 3000)
      : null;
    return () => {
      generation.current += 1;
      if (timer !== null) clearInterval(timer);
    };
  }, [refresh, enabled]);
  useRealtime("runs:changed", () => void refresh());
  function accept(entry: UpdateEntry) {
    generation.current += 1;
    setData((previous) => ({
      incoming: previous?.incoming ?? null,
      outgoing: entry,
    }));
    setError(null);
  }
  const application = data?.outgoing?.application;
  const blockedReason = !enabled
    ? null
    : error
      ? "Run update status is unavailable. Refresh it before changing this run."
      : !data
        ? "Checking run update status…"
        : application && application.state !== "cancelled"
          ? application.state === "applied"
            ? "This run was replaced. Continue in the linked run."
            : "A reviewed update is managing this run. Finish or cancel it before using ordinary run controls."
          : null;
  return { data, error, refresh, accept, blockedReason };
}

type UpdateQuery<A> = {
  data: { incoming: A | null; outgoing: A | null } | null;
  error: string | null;
  refresh(): Promise<void>;
  accept(application: A): void;
  blockedReason: string | null;
};
export type InstructionUpdateQuery = UpdateQuery<InstructionUpdateApplication>;
export type RuleUpdateQuery = UpdateQuery<RuleUpdateApplication>;

export function instructionUpdateQuery(
  query: ReturnType<typeof useRunUpdates>,
): InstructionUpdateQuery {
  return {
    ...query,
    data: query.data
      ? {
          incoming:
            query.data.incoming?.kind === "instructions"
              ? query.data.incoming.application
              : null,
          outgoing:
            query.data.outgoing?.kind === "instructions"
              ? query.data.outgoing.application
              : null,
        }
      : null,
    accept: (application) =>
      query.accept({ kind: "instructions", application }),
  };
}

export function ruleUpdateQuery(
  query: ReturnType<typeof useRunUpdates>,
): RuleUpdateQuery {
  return {
    ...query,
    data: query.data
      ? {
          incoming:
            query.data.incoming?.kind === "rules"
              ? query.data.incoming.application
              : null,
          outgoing:
            query.data.outgoing?.kind === "rules"
              ? query.data.outgoing.application
              : null,
        }
      : null,
    accept: (application) => query.accept({ kind: "rules", application }),
  };
}

export function RunUpdateLineage({ state }: { state: UpdateState | null }) {
  const navigate = useBbNavigate();
  if (!state?.incoming && !state?.outgoing) return null;
  const incoming = state.incoming?.application;
  const outgoing = state.outgoing?.application;
  return (
    <section
      aria-label="Run update history"
      className="space-y-2 border-b px-4 py-3 text-sm"
    >
      {incoming && (
        <p>
          Continued with team v{incoming.preview.newTeam.revision}
          {state.incoming?.kind === "rules"
            ? " and reviewed operational rules"
            : ""}
          . Calls, active time and repair usage carry forward.
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate.toPluginPanel("runs", { subPath: incoming.runId })
            }
          >
            Previous run
          </Button>
        </p>
      )}
      {outgoing && outgoing.state !== "cancelled" && (
        <p>
          {outgoing.state === "applied"
            ? `Replaced by ${state.outgoing?.kind === "rules" ? "a rule" : "an instruction"} update. Earlier results are historical.`
            : `${state.outgoing?.kind === "rules" ? "Rule" : "Instruction"} update ${outgoing.state}.`}
          {outgoing.state === "applied" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                navigate.toPluginPanel("runs", {
                  subPath: outgoing.successorRunId,
                })
              }
            >
              Open continuation
            </Button>
          )}
        </p>
      )}
    </section>
  );
}
