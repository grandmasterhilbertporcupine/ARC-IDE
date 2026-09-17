import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { TeamCanvas } from "../teams/canvas.js";
import type { TeamEdge, TeamMember, TeamNode } from "../teams/contract.js";
import { stageLabels, type BuilderSelection } from "../teams/ui-data.js";
import type { ArcWorkspaceView, ArcWorkspaceWorker } from "./contract.js";

type WorkspaceGraphProps = {
  visible: boolean;
  run: ArcWorkspaceView["run"];
  workers: ArcWorkspaceWorker[];
  workersTruncated: boolean;
  onWorker(worker: ArcWorkspaceWorker): void;
  onRunDetails(): void;
};
type SavedDefinition = Exclude<
  ArcWorkspaceView["run"]["definition"],
  { schemaVersion: 1 }
>;
const SavedCanvas = memo(TeamCanvas);
function savedMember(saved: SavedDefinition, member: TeamMember | undefined) {
  const snapshot = member ? saved.members[member.id] : null;
  return member &&
    snapshot &&
    snapshot.definition.agentId === member.agentId &&
    snapshot.definition.revision === member.revision
    ? snapshot
    : null;
}
const outcomes: Record<TeamEdge["requiredOutcome"], string> = {
  succeeded: "Success",
  failed: "Failure",
  completed: "Completion, whether successful or failed",
};
const handles: Record<TeamEdge["sourceHandle"], string> = {
  next: "Next",
  true: "True branch",
  false: "False branch",
  repaired: "Repaired",
  exhausted: "Repair allowance exhausted",
};
const states: Record<ArcWorkspaceWorker["state"], string> = {
  admitted: "Assigned",
  preparing: "Preparing workspace",
  prepared: "Ready to dispatch",
  "dispatch-requested": "Waiting for provider",
  "native-accepted": "Working",
  succeeded: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
  "needs-reconciliation": "Needs reconciliation",
  unavailable: "Status unavailable",
};

function nodeMembers(node: TeamNode): string[] {
  if (node.kind === "agent" || node.kind === "review") return [node.memberId];
  if (node.kind === "repair") return [node.body.memberId];
  if (node.kind === "delegation")
    return [node.requesterMemberId, ...node.candidateMemberIds];
  return [];
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
        {children}
      </dd>
    </div>
  );
}

function NodeDetails({
  node,
  saved,
}: {
  node: TeamNode;
  saved: SavedDefinition;
}) {
  const definition = saved.team.definition;
  const stageName = (id: string) => {
    const stage = definition.graph.nodes.find((value) => value.id === id);
    return stage ? `${stage.label} (${id})` : `Unavailable stage (${id})`;
  };
  const candidate = (
    value: { kind: "source" } | { kind: "node"; nodeId: string },
  ) => (value.kind === "source" ? "Original project" : stageName(value.nodeId));
  const facts: { label: string; value: ReactNode }[] = [];
  switch (node.kind) {
    case "agent":
      facts.push(
        { label: "Assignment", value: node.task },
        {
          label: "Access",
          value:
            node.access === "write"
              ? "May change its assigned candidate"
              : "Read only",
        },
        { label: "Input candidate", value: candidate(node.candidate) },
      );
      break;
    case "review":
      facts.push(
        { label: "Review assignment", value: node.task },
        { label: "Candidate to review", value: candidate(node.candidate) },
      );
      break;
    case "repair":
      facts.push(
        { label: "Repair assignment", value: node.body.task },
        { label: "Required check", value: stageName(node.checkNodeId) },
        {
          label: "Repair allowance",
          value: `${node.maxRounds} configured rounds; ${Math.min(node.maxRounds, saved.policy.limits.maxRepairRounds)} effective total rounds for this saved run`,
        },
      );
      break;
    case "check":
      facts.push(
        { label: "Input candidate", value: candidate(node.candidate) },
        {
          label: "Required command",
          value: (
            <code>
              {node.command.executable}
              {"\n"}
              {JSON.stringify(node.command.args)}
            </code>
          ),
        },
        { label: "Timeout", value: `${node.command.timeoutMs / 1000} seconds` },
      );
      break;
    case "parallel":
      facts.push({
        label: "Behavior",
        value:
          "Declared branches may run in parallel within the saved concurrency and call limits.",
      });
      break;
    case "join":
      facts.push({
        label: "Wait for",
        value:
          node.mode === "all"
            ? "All required incoming branches"
            : "The branches chosen by the declared decision",
      });
      if (node.decisionNodeId)
        facts.push({
          label: "Decision",
          value: stageName(node.decisionNodeId),
        });
      break;
    case "condition":
      facts.push({
        label: "Declared condition",
        value: <code>{JSON.stringify(node.predicate, null, 2)}</code>,
      });
      break;
    case "approval":
      facts.push({ label: "User approval", value: node.message });
      if (node.candidate)
        facts.push({ label: "Candidate", value: candidate(node.candidate) });
      break;
    case "integration":
      facts.push(
        { label: "Base candidate", value: candidate(node.baseCandidate) },
        {
          label: "Writer outputs",
          value: node.writerNodeIds.map(stageName).join("\n"),
        },
      );
      break;
    case "release":
      facts.push(
        {
          label: "Release target",
          value: node.target === "pull-request" ? "Pull request" : "Deploy",
        },
        { label: "Candidate", value: candidate(node.candidate) },
        {
          label: "Configuration",
          value: node.configurationRef ?? "No configuration selected",
        },
      );
      break;
    case "delegation":
      facts.push(
        { label: "Coordinator assignment", value: node.task },
        { label: "Requester member", value: node.requesterMemberId },
        {
          label: "Permitted child members",
          value: node.candidateMemberIds.join(", ") || "None",
        },
        { label: "Child call limit", value: node.maxChildCalls },
        {
          label: "Access",
          value:
            node.access === "write"
              ? "May change its assigned candidate"
              : "Read only",
        },
        { label: "Input candidate", value: candidate(node.candidate) },
      );
      break;
  }
  const gates = definition.graph.requiredGates.filter((gate) =>
    gate.nodeIds.includes(node.id),
  );
  return (
    <>
      <dl className="space-y-3">
        <Detail label="Stage identity">
          {node.id} · {stageLabels[node.kind]}
        </Detail>
        {facts.map((fact) => (
          <Detail key={fact.label} label={fact.label}>
            {fact.value}
          </Detail>
        ))}
        {nodeMembers(node).map((memberId) => {
          const member = definition.members.find(
            (value) => value.id === memberId,
          );
          const snapshot = savedMember(saved, member);
          return (
            <Detail key={memberId} label={`Saved member · ${memberId}`}>
              {snapshot ? (
                <>
                  {snapshot.definition.metadata.name}
                  {"\n"}
                  {snapshot.definition.agentId} · agent v
                  {snapshot.definition.revision}
                  {"\n"}
                  {snapshot.execution.providerId} · {snapshot.execution.model}
                </>
              ) : (
                <>
                  Saved agent snapshot is unavailable or does not match this
                  member’s pinned revision.
                </>
              )}
            </Detail>
          );
        })}
        {gates.length > 0 && (
          <Detail label="Required completion gates">
            {gates
              .map(
                (gate) =>
                  `${gate.id}: ${gate.mode === "all" ? "all" : "any"} of ${gate.nodeIds.map(stageName).join(", ")}`,
              )
              .join("\n")}
          </Detail>
        )}
        {definition.permissions.some(
          (grant) =>
            nodeMembers(node).includes(grant.fromMemberId) ||
            nodeMembers(node).includes(grant.toMemberId),
        ) && (
          <Detail label="Saved collaboration permissions">
            {definition.permissions
              .filter(
                (grant) =>
                  nodeMembers(node).includes(grant.fromMemberId) ||
                  nodeMembers(node).includes(grant.toMemberId),
              )
              .map(
                (grant) =>
                  `${grant.fromMemberId} may ${grant.action === "review" ? "review work by" : "delegate to"} ${grant.toMemberId}`,
              )
              .join("\n")}
          </Detail>
        )}
      </dl>
    </>
  );
}

export function WorkspaceGraph(props: WorkspaceGraphProps) {
  if (props.run.definition.schemaVersion === 1)
    return (
      <section
        aria-label="Saved team graph"
        className="flex h-full min-h-0 flex-col items-start gap-3 overflow-auto p-4"
      >
        <h2 className="text-sm font-medium">Saved team graph</h2>
        <p className="text-sm text-muted-foreground">
          This earlier run has no saved Team graph. Its original assignments and
          evidence remain in Run details.
        </p>
        <Button size="sm" variant="outline" onClick={props.onRunDetails}>
          Open Run details
        </Button>
      </section>
    );
  return (
    <GraphInspection
      key={`${props.run.summary.runId}:${props.run.summary.planHash}`}
      visible={props.visible}
      savedDefinition={props.run.definition}
      runId={props.run.summary.runId}
      workers={props.workers}
      workersTruncated={props.workersTruncated}
      onWorker={props.onWorker}
      onRunDetails={props.onRunDetails}
    />
  );
}

function GraphInspection({
  visible,
  savedDefinition,
  runId,
  workers,
  workersTruncated,
  onWorker,
  onRunDetails,
}: Omit<WorkspaceGraphProps, "run"> & {
  savedDefinition: SavedDefinition;
  runId: string;
}) {
  const [saved] = useState(savedDefinition);
  const definition = saved.team.definition;
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<BuilderSelection>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previousVisible, setPreviousVisible] = useState(visible);
  const [compact, setCompact] = useState(true);
  const container = useRef<HTMLElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const skipRestore = useRef(false);
  if (previousVisible !== visible) {
    setPreviousVisible(visible);
    if (!visible) setDetailsOpen(false);
  }
  useEffect(() => {
    if (!visible) {
      skipRestore.current = true;
    }
  }, [visible]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setCompact(entry.contentRect.width < 760),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const members = useMemo(
    () =>
      new Map(
        definition.members.map((member) => {
          const snapshot = savedMember(saved, member);
          return [
            member.id,
            {
              name:
                snapshot?.definition.metadata.name ??
                `${member.id} · saved agent unavailable`,
              model: snapshot?.execution.model ?? "Saved model unavailable",
            },
          ];
        }),
      ),
    [definition.members, saved],
  );
  const choices = useMemo(
    () => [
      ...definition.graph.nodes.map((node) => ({
        value: `node:${node.id}`,
        selection: { kind: "node", id: node.id } as const,
        label: `${node.label} (${node.id})`,
        search:
          `${node.label} ${node.id} ${stageLabels[node.kind]} ${nodeMembers(
            node,
          )
            .map((id) => `${id} ${members.get(id)?.name ?? ""}`)
            .join(" ")}`.toLocaleLowerCase(),
        group: "Stages",
      })),
      ...definition.graph.edges.map((edge) => ({
        value: `edge:${edge.id}`,
        selection: { kind: "edge", id: edge.id } as const,
        label: `${edge.source} → ${edge.target} (${edge.id})`,
        search:
          `${edge.id} ${edge.source} ${edge.target} ${handles[edge.sourceHandle]} ${outcomes[edge.requiredOutcome]}`.toLocaleLowerCase(),
        group: "Connections",
      })),
      ...definition.groups.map((group) => ({
        value: `group:${group.id}`,
        selection: { kind: "group", id: group.id } as const,
        label: `${group.name} (${group.id})`,
        search: `${group.name} ${group.id}`.toLocaleLowerCase(),
        group: "Groups",
      })),
    ],
    [definition, members],
  );
  const visibleChoices = useMemo(
    () =>
      choices.filter((choice) =>
        choice.search.includes(search.trim().toLocaleLowerCase()),
      ),
    [choices, search],
  );
  const select = useCallback((value: BuilderSelection) => {
    skipRestore.current = false;
    if (document.activeElement instanceof HTMLElement)
      returnFocus.current = document.activeElement;
    setSelection(value);
    setDetailsOpen(value !== null);
  }, []);
  const restoreFocus = useCallback(() => {
    if (!visible) return;
    if (skipRestore.current) {
      skipRestore.current = false;
      return;
    }
    const target = returnFocus.current?.isConnected
      ? returnFocus.current
      : picker.current;
    target?.focus();
  }, [visible]);
  const close = () => {
    setDetailsOpen(false);
    if (!compact) restoreFocus();
  };
  const selectedNode =
    selection?.kind === "node"
      ? definition.graph.nodes.find((node) => node.id === selection.id)
      : null;
  const selectedEdge =
    selection?.kind === "edge"
      ? definition.graph.edges.find((edge) => edge.id === selection.id)
      : null;
  const selectedGroup =
    selection?.kind === "group"
      ? definition.groups.find((group) => group.id === selection.id)
      : null;
  const matchingWorkers = selectedNode
    ? workers.filter((worker) => worker.graphNodeId === selectedNode.id)
    : [];
  const title =
    selectedNode?.label ??
    (selectedEdge
      ? "Saved connection"
      : (selectedGroup?.name ?? "Plan details"));
  const selectedValue = selection ? `${selection.kind}:${selection.id}` : "";
  const selectedChoice = choices.find(
    (choice) => choice.value === selectedValue,
  );
  const details = (
    <div className="space-y-4 p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="break-words text-sm font-medium">{title}</h3>
        <Button size="sm" variant="ghost" onClick={close}>
          Close details
        </Button>
      </div>
      {selectedNode && <NodeDetails node={selectedNode} saved={saved} />}
      {selectedEdge && (
        <dl className="space-y-3">
          <Detail label="Connection identity">{selectedEdge.id}</Detail>
          <Detail label="From">
            {
              definition.graph.nodes.find(
                (node) => node.id === selectedEdge.source,
              )?.label
            }{" "}
            ({selectedEdge.source})
          </Detail>
          <Detail label="To">
            {
              definition.graph.nodes.find(
                (node) => node.id === selectedEdge.target,
              )?.label
            }{" "}
            ({selectedEdge.target})
          </Detail>
          <Detail label="Selected output">
            {handles[selectedEdge.sourceHandle]}
          </Detail>
          <Detail label="Required outcome">
            {outcomes[selectedEdge.requiredOutcome]}
          </Detail>
        </dl>
      )}
      {selectedGroup && (
        <dl className="space-y-3">
          <Detail label="Group identity">{selectedGroup.id}</Detail>
          <Detail label="Color">{selectedGroup.color}</Detail>
          <Detail label="Parent group">
            {selectedGroup.parentGroupId ?? "No parent group"}
          </Detail>
          <Detail label="Meaning">
            Groups organize the saved plan. Color does not grant permission.
          </Detail>
        </dl>
      )}
      {selectedNode && (
        <section
          aria-label="Worker attempts for selected stage"
          className="space-y-2 border-t pt-3"
        >
          <h4 className="text-xs font-medium">Worker attempts in this view</h4>
          {matchingWorkers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No worker attempt for this stage is included in this view. This
              does not establish whether the stage ran; checks and controls have
              separate evidence.
            </p>
          ) : (
            matchingWorkers.map((worker) => (
              <div
                key={worker.effectId}
                className="space-y-1 border-b pb-2 text-xs"
              >
                <p className="font-medium">
                  {worker.name} · {worker.purpose} · agent v{worker.revision}
                </p>
                <p>
                  {states[worker.state]} · iteration {worker.iteration} ·
                  attempt {worker.attempt}
                </p>
                <p className="break-all text-muted-foreground">
                  {worker.effectId}
                </p>
                {worker.reason && (
                  <p className="text-muted-foreground">{worker.reason}</p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={worker.threadId === null}
                  onClick={() => {
                    skipRestore.current = true;
                    setDetailsOpen(false);
                    onWorker(worker);
                  }}
                >
                  {worker.threadId === null
                    ? "Conversation not available"
                    : `Open ${worker.name} · attempt ${worker.attempt}`}
                </Button>
              </div>
            ))
          )}
          <Button size="sm" variant="ghost" onClick={onRunDetails}>
            Open Run details
          </Button>
        </section>
      )}
    </div>
  );
  return (
    <section
      ref={container}
      aria-label="Saved team graph"
      className="flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsOpen && !compact) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="space-y-2 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium" title={runId}>
            {definition.name} · team v{saved.team.revision}
          </h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {definition.graph.nodes.length} stages
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Search saved plan"
            placeholder="Search stages, connections or agents"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 min-w-0 flex-1 text-sm"
          />
          <select
            ref={picker}
            aria-label="Inspect saved stage or connection"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            value={selectedValue}
            onChange={(event) =>
              select(
                choices.find((choice) => choice.value === event.target.value)
                  ?.selection ?? null,
              )
            }
          >
            <option value="">Choose a stage or connection</option>
            {selectedChoice && !visibleChoices.includes(selectedChoice) && (
              <option value={selectedChoice.value}>
                {selectedChoice.label}
              </option>
            )}
            {["Stages", "Connections", "Groups"].map((group) => (
              <optgroup key={group} label={group}>
                {visibleChoices
                  .filter((choice) => choice.group === group)
                  .map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          {selection && !detailsOpen && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                skipRestore.current = false;
                returnFocus.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                setDetailsOpen(true);
              }}
            >
              Show details
            </Button>
          )}
        </div>
        {search && (
          <p role="status" className="text-xs text-muted-foreground">
            {visibleChoices.length} matching items
          </p>
        )}
        {workersTruncated && (
          <p className="text-xs text-muted-foreground">
            Only part of the worker history is included. Open Run details for
            other attempts.
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <SavedCanvas
            definition={definition}
            members={members}
            mode="inspect"
            selection={selection}
            onSelect={select}
          />
        </div>
        {visible && !compact && detailsOpen && (
          <aside
            role="region"
            aria-label="Saved plan details"
            className="w-72 shrink-0 overflow-y-auto border-l"
          >
            {details}
          </aside>
        )}
      </div>
      {compact && (
        <ResponsiveDrawerShell
          open={visible && detailsOpen}
          onOpenChange={setDetailsOpen}
          onAfterCloseAutoFocus={restoreFocus}
          srLabel="Saved plan details"
          contentClassName="max-h-[85dvh] overflow-y-auto"
        >
          {details}
        </ResponsiveDrawerShell>
      )}
    </section>
  );
}
