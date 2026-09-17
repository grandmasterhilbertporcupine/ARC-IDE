import type { ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import type { TeamDefinition, TeamEdge, TeamNode } from "./contract.js";
import { stageLabels } from "./ui-data.js";
import { ReviewGrantRequirements } from "./review-grants-view.js";

export const selectClass =
  "h-8 w-full rounded-md border bg-background px-2 text-sm text-foreground";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed">{hint}</span>}
    </label>
  );
}

type Candidate = Extract<TeamNode, { kind: "check" }>["candidate"];

function CandidateField({
  value,
  definition,
  currentId,
  onChange,
}: {
  value: Candidate;
  definition: TeamDefinition;
  currentId: string;
  onChange(value: Candidate): void;
}) {
  return (
    <Field
      label="Code to work on"
      hint="Choose the original project or an earlier stage’s exact output."
    >
      <select
        aria-label="Code to work on"
        className={selectClass}
        value={value.kind === "source" ? "source" : value.nodeId}
        onChange={(event) =>
          onChange(
            event.target.value === "source"
              ? { kind: "source" }
              : { kind: "node", nodeId: event.target.value },
          )
        }
      >
        <option value="source">Original project</option>
        {definition.graph.nodes
          .filter(
            (item) =>
              item.id !== currentId &&
              (item.kind === "integration" ||
                item.kind === "repair" ||
                (definition.schemaVersion === 2 &&
                  item.kind === "join" &&
                  item.mode === "selected") ||
                ((item.kind === "agent" || item.kind === "delegation") &&
                  item.access === "write")),
          )
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
      </select>
    </Field>
  );
}

function MemberSelect({
  value,
  definition,
  names,
  onChange,
  label = "Agent",
}: {
  value: string;
  definition: TeamDefinition;
  names: Map<string, { name: string; model: string }>;
  onChange(value: string): void;
  label?: string;
}) {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="unassigned">Choose a team member</option>
        {definition.members.map((member) => (
          <option key={member.id} value={member.id}>
            {names.get(member.id)?.name ?? member.id} · v{member.revision}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function StageInspector({
  node,
  definition,
  names,
  onChange,
  onDefinitionChange,
  onDelete,
}: {
  node: TeamNode;
  definition: TeamDefinition;
  names: Map<string, { name: string; model: string }>;
  onChange(node: TeamNode): void;
  onDefinitionChange(definition: TeamDefinition): void;
  onDelete(): void;
}) {
  const updateEntry = (checked: boolean) =>
    onDefinitionChange({
      ...definition,
      graph: {
        ...definition.graph,
        entryNodeIds: checked
          ? [...new Set([...definition.graph.entryNodeIds, node.id])]
          : definition.graph.entryNodeIds.filter((id) => id !== node.id),
      },
    });
  const updateRequired = (checked: boolean) =>
    onDefinitionChange({
      ...definition,
      graph: {
        ...definition.graph,
        requiredGates: checked
          ? [
              ...definition.graph.requiredGates,
              { id: `required_${node.id}`, mode: "all", nodeIds: [node.id] },
            ]
          : definition.graph.requiredGates
              .map((gate) =>
                gate.mode === "all"
                  ? {
                      ...gate,
                      nodeIds: gate.nodeIds.filter((id) => id !== node.id),
                    }
                  : gate,
              )
              .filter((gate) => gate.nodeIds.length > 0),
      },
    });
  return (
    <div className="space-y-4 p-4" data-team-stage-inspector>
      <div>
        <h2 className="text-sm font-medium">{stageLabels[node.kind]}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Edit what this stage does and what it needs.
        </p>
      </div>
      <Field label="Stage name">
        <Input
          aria-label="Stage name"
          value={node.label}
          maxLength={100}
          onChange={(event) => onChange({ ...node, label: event.target.value })}
        />
      </Field>
      {"memberId" in node && (
        <MemberSelect
          value={node.memberId}
          definition={definition}
          names={names}
          onChange={(memberId) => onChange({ ...node, memberId })}
        />
      )}
      {"task" in node && (
        <Field label="Assignment">
          <Textarea
            aria-label="Assignment"
            rows={5}
            value={node.task}
            maxLength={16000}
            onChange={(event) =>
              onChange({ ...node, task: event.target.value })
            }
            placeholder="Describe the outcome and how to verify it."
          />
        </Field>
      )}
      {(node.kind === "agent" || node.kind === "delegation") && (
        <Field
          label="Work type"
          hint="This describes the assigned work. Provider and host permissions still apply."
        >
          <select
            aria-label="Work type"
            className={selectClass}
            value={node.access}
            onChange={(event) =>
              onChange({
                ...node,
                access: event.target.value === "write" ? "write" : "read",
              })
            }
          >
            <option value="write">Make changes</option>
            <option value="read">Inspect without changes</option>
          </select>
        </Field>
      )}
      {"candidate" in node && node.candidate !== null && (
        <CandidateField
          value={node.candidate}
          definition={definition}
          currentId={node.id}
          onChange={(candidate) => onChange({ ...node, candidate })}
        />
      )}
      {node.kind === "review" && (
        <ReviewGrantRequirements
          definition={definition}
          names={names}
          reviewNodeId={node.id}
        />
      )}
      {node.kind === "parallel" && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Connect two or more outgoing paths. Each writer receives an isolated
          workspace. Add a join before dependent work.
        </p>
      )}
      {node.kind === "join" && (
        <>
          <Field label="Wait for">
            <select
              aria-label="Wait for"
              className={selectClass}
              value={node.mode}
              onChange={(event) =>
                onChange({
                  ...node,
                  mode: event.target.value === "selected" ? "selected" : "all",
                  decisionNodeId:
                    event.target.value === "all" ? null : node.decisionNodeId,
                })
              }
            >
              <option value="all">Every connected path</option>
              <option value="selected">Paths selected by a condition</option>
            </select>
          </Field>
          {node.mode === "selected" && (
            <Field label="Condition controlling this join">
              <select
                aria-label="Condition controlling this join"
                className={selectClass}
                value={node.decisionNodeId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...node,
                    decisionNodeId: event.target.value || null,
                  })
                }
              >
                <option value="">Choose a condition</option>
                {definition.graph.nodes
                  .filter((item) => item.kind === "condition")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {node.mode === "selected" && definition.schemaVersion === 2 && (
            <p className="text-xs text-muted-foreground">
              When each alternative produces one candidate, this join forwards
              the selected candidate for later work or integration. Conflicting
              candidates must be integrated within their branch first.
            </p>
          )}
        </>
      )}
      {node.kind === "check" && (
        <>
          <Field
            label="Executable"
            hint="A real executable on the project’s host; no shell expression."
          >
            <Input
              aria-label="Executable"
              value={node.command.executable}
              onChange={(event) =>
                onChange({
                  ...node,
                  command: { ...node.command, executable: event.target.value },
                })
              }
              placeholder="For example: node"
            />
          </Field>
          <Field
            label="Arguments"
            hint="One argument per line. Each line is passed literally."
          >
            <Textarea
              aria-label="Arguments"
              rows={4}
              value={node.command.args.join("\n")}
              onChange={(event) =>
                onChange({
                  ...node,
                  command: {
                    ...node.command,
                    args:
                      event.target.value === ""
                        ? []
                        : event.target.value.split("\n"),
                  },
                })
              }
            />
          </Field>
          <Field label="Timeout in seconds">
            <Input
              aria-label="Timeout in seconds"
              type="number"
              min={1}
              max={3600}
              value={node.command.timeoutMs / 1000}
              onChange={(event) =>
                onChange({
                  ...node,
                  command: {
                    ...node.command,
                    timeoutMs: Number(event.target.value) * 1000,
                  },
                })
              }
            />
          </Field>
        </>
      )}
      {node.kind === "condition" && (
        <>
          <Field label="Inspect result">
            <select
              aria-label="Inspect result"
              className={selectClass}
              value={node.predicate.kind}
              onChange={(event) => {
                const sourceNodeId = node.predicate.sourceNodeId;
                switch (event.target.value) {
                  case "check-exit":
                    onChange({
                      ...node,
                      predicate: {
                        kind: "check-exit",
                        sourceNodeId,
                        operator: "eq",
                        value: 0,
                      },
                    });
                    break;
                  case "review-verdict":
                    onChange({
                      ...node,
                      predicate: {
                        kind: "review-verdict",
                        sourceNodeId,
                        equals: "approved",
                      },
                    });
                    break;
                  case "approval":
                    onChange({
                      ...node,
                      predicate: {
                        kind: "approval",
                        sourceNodeId,
                        equals: "approved",
                      },
                    });
                    break;
                  default:
                    onChange({
                      ...node,
                      predicate: {
                        kind: "outcome",
                        sourceNodeId,
                        equals: "succeeded",
                      },
                    });
                }
              }}
            >
              <option value="outcome">Stage outcome</option>
              <option value="check-exit">Check exit code</option>
              <option value="review-verdict">Review verdict</option>
              <option value="approval">User approval</option>
            </select>
          </Field>
          <Field label="Result from stage">
            <select
              aria-label="Result from stage"
              className={selectClass}
              value={node.predicate.sourceNodeId}
              onChange={(event) =>
                onChange({
                  ...node,
                  predicate: {
                    ...node.predicate,
                    sourceNodeId: event.target.value,
                  },
                })
              }
            >
              <option value="unassigned">Choose an earlier stage</option>
              {definition.graph.nodes
                .filter((item) => item.id !== node.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </Field>
          {node.predicate.kind === "check-exit" ? (
            <>
              <Field label="Comparison">
                <select
                  aria-label="Comparison"
                  className={selectClass}
                  value={node.predicate.operator}
                  onChange={(event) => {
                    if (node.predicate.kind === "check-exit")
                      onChange({
                        ...node,
                        predicate: {
                          ...node.predicate,
                          operator: event.target.value === "ne" ? "ne" : "eq",
                        },
                      });
                  }}
                >
                  <option value="eq">Equals</option>
                  <option value="ne">Does not equal</option>
                </select>
              </Field>
              <Field label="Exit code">
                <Input
                  aria-label="Exit code"
                  type="number"
                  value={node.predicate.value}
                  onChange={(event) => {
                    if (node.predicate.kind === "check-exit")
                      onChange({
                        ...node,
                        predicate: {
                          ...node.predicate,
                          value: Number(event.target.value),
                        },
                      });
                  }}
                />
              </Field>
            </>
          ) : (
            <Field label="Expected result">
              <select
                aria-label="Expected result"
                className={selectClass}
                value={node.predicate.equals}
                onChange={(event) => {
                  if (node.predicate.kind === "outcome")
                    onChange({
                      ...node,
                      predicate: {
                        ...node.predicate,
                        equals:
                          event.target.value === "failed"
                            ? "failed"
                            : "succeeded",
                      },
                    });
                  else if (node.predicate.kind !== "check-exit")
                    onChange({
                      ...node,
                      predicate: {
                        ...node.predicate,
                        equals:
                          event.target.value === "rejected"
                            ? "rejected"
                            : "approved",
                      },
                    });
                }}
              >
                {node.predicate.kind === "outcome" ? (
                  <>
                    <option value="succeeded">Succeeded</option>
                    <option value="failed">Failed</option>
                  </>
                ) : (
                  <>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                  </>
                )}
              </select>
            </Field>
          )}
          <p className="text-xs text-muted-foreground">
            Connect both Yes and No handles. Conditions use recorded results,
            never an agent’s prose.
          </p>
        </>
      )}
      {node.kind === "repair" && (
        <>
          <MemberSelect
            value={node.body.memberId}
            definition={definition}
            names={names}
            onChange={(memberId) =>
              onChange({ ...node, body: { ...node.body, memberId } })
            }
            label="Repair agent"
          />
          <Field label="Repair instructions">
            <Textarea
              aria-label="Repair instructions"
              rows={4}
              value={node.body.task}
              onChange={(event) =>
                onChange({
                  ...node,
                  body: { ...node.body, task: event.target.value },
                })
              }
            />
          </Field>
          <Field label="Check to rerun">
            <select
              aria-label="Check to rerun"
              className={selectClass}
              value={node.checkNodeId}
              onChange={(event) =>
                onChange({ ...node, checkNodeId: event.target.value })
              }
            >
              <option value="unassigned">Choose a check</option>
              {definition.graph.nodes
                .filter((item) => item.kind === "check")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Maximum repair rounds">
            <Input
              aria-label="Maximum repair rounds"
              type="number"
              min={1}
              max={3}
              value={node.maxRounds}
              onChange={(event) =>
                onChange({ ...node, maxRounds: Number(event.target.value) })
              }
            />
          </Field>
        </>
      )}
      {node.kind === "approval" && (
        <>
          <Field label="What should the user approve?">
            <Textarea
              aria-label="What should the user approve?"
              rows={4}
              value={node.message}
              onChange={(event) =>
                onChange({ ...node, message: event.target.value })
              }
            />
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={node.candidate !== null}
              onChange={(event) =>
                onChange({
                  ...node,
                  candidate: event.target.checked ? { kind: "source" } : null,
                })
              }
            />
            Bind approval to a code candidate
          </label>
        </>
      )}
      {node.kind === "integration" && (
        <>
          <CandidateField
            value={node.baseCandidate}
            definition={definition}
            currentId={node.id}
            onChange={(baseCandidate) => onChange({ ...node, baseCandidate })}
          />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs text-muted-foreground">
              Changes to integrate, in order
            </legend>
            {definition.graph.nodes
              .filter(
                (item) =>
                  item.id !== node.id &&
                  (((item.kind === "agent" || item.kind === "delegation") &&
                    item.access === "write") ||
                    (definition.schemaVersion === 2 &&
                      (item.kind === "integration" ||
                        item.kind === "repair" ||
                        (item.kind === "join" && item.mode === "selected")))),
              )
              .map((item) => (
                <label
                  key={item.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={node.writerNodeIds.includes(item.id)}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        writerNodeIds: event.target.checked
                          ? [...node.writerNodeIds, item.id]
                          : node.writerNodeIds.filter((id) => id !== item.id),
                      })
                    }
                  />
                  {item.label}
                  {node.writerNodeIds.includes(item.id) && (
                    <span className="text-muted-foreground">
                      {node.writerNodeIds.indexOf(item.id) + 1}
                    </span>
                  )}
                </label>
              ))}
          </fieldset>
        </>
      )}
      {node.kind === "release" && (
        <>
          <p
            role="status"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            Release execution becomes available with configured factory checks
            and permissions. Saving this stage does not authorize a release.
          </p>
          <Field label="Release destination">
            <select
              aria-label="Release destination"
              className={selectClass}
              value={node.target}
              onChange={(event) =>
                onChange({
                  ...node,
                  target:
                    event.target.value === "deploy" ? "deploy" : "pull-request",
                })
              }
            >
              <option value="pull-request">Pull request</option>
              <option value="deploy">Deployment</option>
            </select>
          </Field>
          <Field label="Release configuration reference">
            <Input
              aria-label="Release configuration reference"
              value={node.configurationRef ?? ""}
              onChange={(event) =>
                onChange({
                  ...node,
                  configurationRef: event.target.value || null,
                })
              }
            />
          </Field>
        </>
      )}
      {node.kind === "delegation" && (
        <>
          <MemberSelect
            label="Requesting agent"
            value={node.requesterMemberId}
            definition={definition}
            names={names}
            onChange={(requesterMemberId) =>
              onChange({ ...node, requesterMemberId })
            }
          />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs text-muted-foreground">
              Permitted candidates
            </legend>
            {definition.members
              .filter((member) => member.id !== node.requesterMemberId)
              .map((member) => (
                <label
                  key={member.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={node.candidateMemberIds.includes(member.id)}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        candidateMemberIds: event.target.checked
                          ? [...node.candidateMemberIds, member.id]
                          : node.candidateMemberIds.filter(
                              (id) => id !== member.id,
                            ),
                      })
                    }
                  />
                  {names.get(member.id)?.name ?? member.id}
                </label>
              ))}
          </fieldset>
          <Field label="Maximum delegated calls">
            <Input
              aria-label="Maximum delegated calls"
              type="number"
              min={1}
              max={100}
              value={node.maxChildCalls}
              onChange={(event) =>
                onChange({ ...node, maxChildCalls: Number(event.target.value) })
              }
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Each candidate also needs a directed delegation grant in People
            &amp; groups. All calls stay within the run’s limits.
          </p>
        </>
      )}
      <fieldset className="space-y-3 border-t pt-3">
        <legend className="sr-only">Stage requirements</legend>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={definition.graph.entryNodeIds.includes(node.id)}
            onChange={(event) => updateEntry(event.target.checked)}
          />
          Start the graph here
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={definition.graph.requiredGates.some(
              (gate) => gate.mode === "all" && gate.nodeIds.includes(node.id),
            )}
            onChange={(event) => updateRequired(event.target.checked)}
          />
          Required before this run can succeed
        </label>
      </fieldset>
      <Button variant="ghost" size="sm" onClick={onDelete}>
        Remove stage
      </Button>
    </div>
  );
}

export function EdgeInspector({
  edge,
  definition,
  onChange,
  onDelete,
}: {
  edge: TeamEdge;
  definition: TeamDefinition;
  onChange(edge: TeamEdge): void;
  onDelete(): void;
}) {
  const source = definition.graph.nodes.find((node) => node.id === edge.source);
  return (
    <div className="space-y-4 p-4">
      <h2 className="text-sm font-medium">Connection</h2>
      <p className="text-xs text-muted-foreground">
        {source?.label ?? edge.source} →{" "}
        {definition.graph.nodes.find((node) => node.id === edge.target)
          ?.label ?? edge.target}
      </p>
      <Field label="Continue from">
        <select
          aria-label="Continue from"
          className={selectClass}
          value={edge.sourceHandle}
          onChange={(event) => {
            const sourceHandle = [
              "next",
              "true",
              "false",
              "repaired",
              "exhausted",
            ].find((handle) => handle === event.target.value);
            if (
              sourceHandle === "next" ||
              sourceHandle === "true" ||
              sourceHandle === "false" ||
              sourceHandle === "repaired" ||
              sourceHandle === "exhausted"
            )
              onChange({ ...edge, sourceHandle });
          }}
        >
          {(source?.kind === "condition"
            ? [
                ["true", "Yes"],
                ["false", "No"],
              ]
            : source?.kind === "repair"
              ? [
                  ["repaired", "Repaired"],
                  ["exhausted", "Repair limit reached"],
                ]
              : [["next", "Next"]]
          ).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Required result">
        <select
          aria-label="Required result"
          className={selectClass}
          value={edge.requiredOutcome}
          onChange={(event) =>
            onChange({
              ...edge,
              requiredOutcome:
                event.target.value === "failed"
                  ? "failed"
                  : event.target.value === "completed"
                    ? "completed"
                    : "succeeded",
            })
          }
        >
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="completed">Succeeded or failed</option>
        </select>
      </Field>
      <Button variant="ghost" size="sm" onClick={onDelete}>
        Remove connection
      </Button>
    </div>
  );
}
