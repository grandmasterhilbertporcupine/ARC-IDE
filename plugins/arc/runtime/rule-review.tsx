import type { ReactNode } from "react";
import type { ArcRunView } from "./contract.js";
import type { RuleChange, RuleReview } from "./rule-update-contract.js";

const impactLabels: Record<RuleChange["impact"], string> = {
  "increases-authority": "Increases authority or allowance",
  "reduces-authority": "Reduces authority or allowance",
  "mixed-authority": "Changes authority in both directions",
  behavior: "Changes behavior",
  "future-only": "Future runs only",
};
const autonomy = {
  guided: "Guided · approve each assignment",
  collaborative: "Collaborative · approve the plan",
  autonomous: "Autonomous · delegate within the configured plan",
};
const minutes = (ms: number) =>
  `${Math.round((ms / 60_000) * 10) / 10} minutes`;

function Comparison({
  before,
  after,
}: {
  before: ReactNode;
  after: ReactNode;
}) {
  return (
    <div className="mt-2 grid min-w-0 gap-3 lg:grid-cols-2">
      <div>
        <h4 className="font-medium">Current</h4>
        <div className="mt-1 whitespace-pre-wrap break-words">{before}</div>
      </div>
      <div>
        <h4 className="font-medium">Proposed</h4>
        <div className="mt-1 whitespace-pre-wrap break-words">{after}</div>
      </div>
    </div>
  );
}

function ChangeDetails({
  change,
  run,
  review,
}: {
  change: RuleChange;
  run: ArcRunView;
  review: RuleReview;
}) {
  const definition = run.definition;
  const memberName = (memberId: string) =>
    definition.schemaVersion === 1
      ? memberId
      : definition.members[memberId]
        ? `${definition.members[memberId].definition.metadata.name} (${memberId})`
        : memberId;
  const pins = (values: { teamId: string; revision: number }[] | null) =>
    values === null
      ? "No team restriction"
      : values.length === 0
        ? "No teams selected"
        : values
            .map(
              (pin) =>
                `${pin.teamId === review.newTeam.teamId ? review.newTeam.name : pin.teamId} · v${pin.revision}`,
            )
            .join("\n");
  switch (change.kind) {
    case "autonomy":
      return (
        <Comparison
          before={autonomy[change.before]}
          after={autonomy[change.after]}
        />
      );
    case "limits": {
      const format = (limits: typeof change.before) =>
        `${limits.maxConcurrentAgents} concurrent agents\n${limits.maxAgentCalls} total calls\n${minutes(limits.maxActiveMs)} active time\n${limits.maxRepairRounds} repair rounds per stage`;
      return (
        <Comparison
          before={format(change.before)}
          after={format(change.after)}
        />
      );
    }
    case "restricted-teams":
      return (
        <Comparison before={pins(change.before)} after={pins(change.after)} />
      );
    case "preferred-teams":
      return (
        <Comparison
          before={change.before.length ? pins(change.before) : "No preference"}
          after={change.after.length ? pins(change.after) : "No preference"}
        />
      );
    case "collaboration-grant": {
      const grant = (value: typeof change.before) =>
        value === null
          ? "No permission"
          : `${memberName(value.fromMemberId)} may ${value.action === "review" ? "review work by" : "delegate to"} ${memberName(value.toMemberId)}`;
      return (
        <Comparison before={grant(change.before)} after={grant(change.after)} />
      );
    }
    case "delegation-roster":
      return (
        <Comparison
          before={change.before.map(memberName).join(", ")}
          after={change.after.map(memberName).join(", ")}
        />
      );
    case "native-check": {
      const command = (value: typeof change.before) =>
        `${value.executable}\nArguments: ${JSON.stringify(value.args)}\nTimeout: ${value.timeoutMs / 1000} seconds`;
      return (
        <Comparison
          before={<code>{command(change.before)}</code>}
          after={<code>{command(change.after)}</code>}
        />
      );
    }
    case "required-gate": {
      const gate = (value: typeof change.before) =>
        value === null
          ? "Not required"
          : `${value.mode === "all" ? "All" : "Any"} of: ${value.nodeIds
              .map((id) => {
                const node = review.affectedNodes.find(
                  (node) => node.nodeId === id,
                );
                return node ? `${node.label} (${id})` : id;
              })
              .join(", ")}`;
      return (
        <Comparison before={gate(change.before)} after={gate(change.after)} />
      );
    }
    case "repair-ceiling":
      return (
        <Comparison
          before={`${change.beforeNodeMaxRounds} configured rounds\n${change.beforeMaxRounds} effective total rounds`}
          after={`${change.afterNodeMaxRounds} configured rounds\n${change.afterMaxRounds} effective total rounds`}
        />
      );
    case "execution": {
      const execution = (value: typeof change.before | typeof change.after) => (
        <>
          {value.resolved ? (
            <p>
              {value.resolved.providerId} · {value.resolved.model}
              <br />
              Permission: {value.resolved.permissionMode}
              <br />
              Reasoning: {value.resolved.reasoningLevel ?? "Provider default"}
              <br />
              Service tier: {value.resolved.serviceTier ?? "Provider default"}
            </p>
          ) : (
            <p>Execution settings could not be resolved.</p>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer">
              Configured settings and inheritance
            </summary>
            <pre className="mt-1 overflow-auto text-xs">
              {JSON.stringify(value.configured, null, 2)}
            </pre>
          </details>
        </>
      );
      return (
        <Comparison
          before={execution(change.before)}
          after={execution(change.after)}
        />
      );
    }
    case "instructions":
      return (
        <Comparison
          before={
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
              {change.before}
            </pre>
          }
          after={
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
              {change.after}
            </pre>
          }
        />
      );
    case "presentation":
      return (
        <Comparison
          before={
            <pre className="max-h-48 overflow-auto text-xs">
              {JSON.stringify(change.before, null, 2)}
            </pre>
          }
          after={
            <pre className="max-h-48 overflow-auto text-xs">
              {JSON.stringify(change.after, null, 2)}
            </pre>
          }
        />
      );
  }
}

function changeTitle(change: RuleChange) {
  switch (change.kind) {
    case "autonomy":
      return "Orchestrator freedom";
    case "limits":
      return "Execution limits";
    case "restricted-teams":
      return "Allowed teams";
    case "preferred-teams":
      return "Preferred teams";
    case "collaboration-grant":
      return "Collaboration permission";
    case "delegation-roster":
      return `Delegation choices · ${change.label} (${change.nodeId})`;
    case "native-check":
      return `Required check · ${change.label} (${change.nodeId})`;
    case "required-gate":
      return `Completion requirement · ${change.gateId}`;
    case "repair-ceiling":
      return `Repair allowance · ${change.label} (${change.nodeId})`;
    case "execution":
      return `Agent execution · ${change.name} (${change.memberId})`;
    case "instructions":
      return `Instructions · ${change.name} (${change.memberId}) v${change.oldRevision} → v${change.newRevision}`;
    case "presentation":
      return "Team name and appearance";
  }
}

export function RuleReviewDetails({
  review,
  run,
}: {
  review: RuleReview;
  run: ArcRunView;
}) {
  const limits = review.newPolicy.effective.limits;
  const callsLeft = limits.maxAgentCalls - review.usage.agentCalls;
  const timeLeft = limits.maxActiveMs - review.usage.chargedActiveMs;
  return (
    <div className="min-w-0 space-y-3">
      <p className="font-medium">
        {review.oldTeam.name} · v{review.oldTeam.revision} → v
        {review.newTeam.revision}
      </p>
      <p>
        Used {review.usage.agentCalls} calls and{" "}
        {minutes(review.usage.chargedActiveMs)} of active time. The proposed
        total limits leave {Math.max(0, callsLeft)} calls and{" "}
        {minutes(Math.max(0, timeLeft))}.
      </p>
      {(callsLeft <= 0 || timeLeft <= 0) && (
        <p role="status">
          The proposed limits leave no allowance for further agent work. A
          continuation may be unable to complete.
        </p>
      )}
      <p className="text-muted-foreground">
        Usage checked {new Date(review.usage.checkedAt).toLocaleString()}.
        Admission rechecks actual usage after the run pauses.
      </p>
      {review.repairStages.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            Repair allowance by stage
          </summary>
          <ul className="mt-2 space-y-1">
            {review.repairStages.map((stage) => {
              const used =
                review.usage.repairRounds.find(
                  (row) => row.stageId === stage.stageId,
                )?.rounds ?? 0;
              return (
                <li key={stage.stageId}>
                  {stage.label}: {used} used; {stage.afterMaxRounds} proposed
                  total; {Math.max(0, stage.afterMaxRounds - used)} remaining.
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {review.changes.map((change, index) => (
        <details
          key={`${change.kind}:${index}`}
          className="border-t pt-2"
          open={change.impact !== "future-only"}
        >
          <summary className="cursor-pointer font-medium">
            {changeTitle(change)}
            <span className="ml-2 font-normal text-muted-foreground">
              {impactLabels[change.impact]}
            </span>
          </summary>
          <ChangeDetails change={change} run={run} review={review} />
        </details>
      ))}
      {review.affectedNodes.length > 0 && (
        <p className="text-muted-foreground">
          Affected steps:{" "}
          {review.affectedNodes.map((node) => node.label).join(", ")}
        </p>
      )}
      <details className="border-t pt-2 text-muted-foreground">
        <summary className="cursor-pointer">
          Source and settings revisions
        </summary>
        <p className="mt-2 break-all">
          Original {review.source.kind === "git" ? "repository" : "folder"}:{" "}
          {review.source.path}
        </p>
        <p>
          Project settings v{review.oldPolicy.projectVersion} → v
          {review.newPolicy.projectVersion}; session settings v
          {review.oldPolicy.sessionVersion} → v{review.newPolicy.sessionVersion}
          .
        </p>
      </details>
    </div>
  );
}
