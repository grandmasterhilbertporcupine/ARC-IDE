import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { usePrefersReducedMotion } from "@bb/shared-ui/hooks/use-media-query";
import { Icon } from "@bb/shared-ui/icon";
import { MemberModelLabel, type MemberIdentity } from "./member-model.js";
import type { TeamDefinition, TeamMember } from "./contract.js";
import type { BuilderSelection } from "./ui-data.js";
import {
  AGENT_DRAG_TYPE,
  canLead,
  memberPosition,
  relationshipLabels,
  type TeamRelationship,
} from "./organization.js";
import {
  visibleTeamConnections,
  type TeamConnectionFilter,
} from "./organization-connections.js";
import "@xyflow/react/dist/base.css";
import "./canvas.css";

type MemberNode = Node<
  {
    member: TeamMember;
    name: string;
    model: string;
    identity: MemberIdentity;
    onEditModel(): void;
    role: string;
    group: string | null;
    color: string;
    lead: boolean;
    reports: number;
    tasks: number;
  },
  "member"
>;

const MemberCard = memo(function MemberCard({
  data,
  selected,
}: NodeProps<MemberNode>) {
  return (
    <div
      className="arc-team-stage"
      data-selected={selected}
      style={{ "--arc-team-color": data.color } as CSSProperties}
    >
      <Handle
        type="source"
        position={Position.Top}
        id="reports-out"
        isConnectable={false}
        className="pointer-events-none opacity-0"
        aria-hidden
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="reports-in"
        isConnectable={false}
        className="pointer-events-none opacity-0"
        aria-hidden
      />
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        aria-label={`Connect to ${data.name}`}
      />
      <div className="arc-team-stage-content">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon name="Bot" className="size-4" />
          <span>
            {data.lead ? "Team lead" : data.reports > 0 ? "Lead" : "Agent"}
          </span>
          {data.group && <span className="ml-auto truncate">{data.group}</span>}
        </div>
        <p className="arc-team-stage-label text-sm font-medium">{data.name}</p>
        <p className="truncate text-xs text-muted-foreground">{data.role}</p>
        <div className="mt-1">
          <MemberModelLabel
            identity={data.identity}
            onEdit={data.onEditModel}
          />
        </div>
        {data.member.responsibility && (
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
            {data.member.responsibility}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {data.tasks} assigned {data.tasks === 1 ? "stage" : "stages"}
          {data.reports > 0 ? ` · ${data.reports} direct reports` : ""}
        </p>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        aria-label={`Connect from ${data.name}`}
      />
    </div>
  );
});
const nodeTypes = { member: MemberCard };
const RelationshipEdge = memo(function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  label,
  data,
  style,
}: EdgeProps<Edge<{ lane: number; hierarchy: boolean }>>) {
  const offset = data?.lane ?? 0;
  const distance = Math.max(80, Math.abs(targetX - sourceX) / 2);
  const [path, labelX, labelY] = data?.hierarchy
    ? getBezierPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
      })
    : ([
        `M ${sourceX},${sourceY} C ${sourceX + distance},${sourceY + offset} ${targetX - distance},${targetY + offset} ${targetX},${targetY}`,
        (sourceX + targetX) / 2,
        (sourceY + targetY) / 2 + offset * 0.75,
      ] as const);
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={{ fill: "var(--foreground)", fontSize: "var(--text-xs)" }}
      labelBgStyle={{ fill: "var(--surface-raised-solid)" }}
      labelBgPadding={[6, 4]}
      labelBgBorderRadius={4}
    />
  );
});
const edgeTypes = { relationship: RelationshipEdge };

export function OrganizationCanvas({
  definition,
  names,
  selection,
  relationship,
  connectionFilter,
  onChange,
  onConnectMembers,
  onSelect,
  onDropAgent,
  onEditModel,
}: {
  definition: TeamDefinition;
  names: Map<string, MemberIdentity>;
  selection: BuilderSelection;
  relationship: TeamRelationship;
  connectionFilter: TeamConnectionFilter;
  onChange(definition: TeamDefinition): void;
  onConnectMembers(source: string, target: string): void;
  onSelect(selection: BuilderSelection): void;
  onDropAgent(agentId: string, position: { x: number; y: number }): void;
  onEditModel(memberId: string): void;
}) {
  const { mode } = experimental_useCodeTheme();
  const reducedMotion = usePrefersReducedMotion();
  const [flow, setFlow] = useState<ReactFlowInstance<MemberNode> | null>(null);
  const latest = useRef(definition);
  latest.current = definition;
  const nodes = useMemo<MemberNode[]>(
    () =>
      definition.members.map((member, index) => {
        const group = definition.groups.find(
          (item) => item.id === member.groupId,
        );
        const identity = names.get(member.id);
        const name = identity?.name ?? "Loading agent…";
        return {
          id: member.id,
          type: "member",
          position: memberPosition(definition, member, index),
          selected: selection?.kind === "member" && selection.id === member.id,
          width: 270,
          ariaLabel: `${name}, ${member.role || "team member"}`,
          data: {
            member,
            name,
            model: identity?.model ?? "Project model",
            identity: identity ?? { name, model: "Loading model…" },
            onEditModel: () => onEditModel(member.id),
            role: member.role || identity?.role || "Custom role",
            group: group?.name ?? null,
            color:
              definition.presentation.color ?? group?.color ?? "var(--border)",
            lead: definition.leaderMemberId === member.id,
            reports: definition.members.filter(
              (item) => item.leaderMemberId === member.id,
            ).length,
            tasks: definition.graph.nodes.filter((node) =>
              node.kind === "agent" || node.kind === "review"
                ? node.memberId === member.id
                : node.kind === "repair"
                  ? node.body.memberId === member.id
                  : node.kind === "delegation"
                    ? node.requesterMemberId === member.id
                    : false,
            ).length,
          },
        };
      }),
    [definition, names, selection, onEditModel],
  );
  const edges = useMemo<Edge[]>(() => {
    const selectedId =
      selection?.kind === "grant"
        ? selection.id
        : selection?.kind === "hierarchy"
          ? `leader:${selection.id}`
          : null;
    const relationships: Edge[] = visibleTeamConnections(
      definition,
      connectionFilter,
      selectedId,
    ).map((connection) => ({
      id: connection.id,
      source: connection.source,
      target: connection.target,
      sourceHandle:
        connection.relationship === "reports-to" ? "reports-out" : "out",
      targetHandle:
        connection.relationship === "reports-to" ? "reports-in" : "in",
      label: relationshipLabels[connection.relationship],
      selected: selectedId === connection.id,
      markerEnd: { type: MarkerType.ArrowClosed },
      ariaLabel: `${names.get(connection.source)?.name ?? connection.source} ${relationshipLabels[connection.relationship].toLowerCase()} ${names.get(connection.target)?.name ?? connection.target}`,
      style: {
        strokeDasharray:
          connection.relationship === "message" ? "5 4" : undefined,
        strokeWidth: connection.relationship === "reports-to" ? 2.5 : undefined,
      },
    }));
    const pairs = new Map<string, Edge[]>();
    for (const edge of relationships) {
      const key = [edge.source, edge.target].sort().join(":");
      pairs.set(key, [...(pairs.get(key) ?? []), edge]);
    }
    return relationships.map((edge) => {
      const siblings = pairs.get(
        [edge.source, edge.target].sort().join(":"),
      ) ?? [edge];
      return {
        ...edge,
        type: "relationship",
        data: {
          lane: (siblings.indexOf(edge) - (siblings.length - 1) / 2) * 72,
          hierarchy: edge.id.startsWith("leader:"),
        },
      };
    });
  }, [definition, names, selection, connectionFilter]);
  const selectEdge = (edge: Edge) =>
    onSelect(
      edge.id.startsWith("leader:")
        ? { kind: "hierarchy", id: edge.id.slice(7) }
        : { kind: "grant", id: edge.id },
    );
  const valid = (connection: Connection | Edge) =>
    connection.source !== connection.target &&
    (relationship !== "reports-to" ||
      canLead(latest.current, connection.target, connection.source));
  return (
    <div
      className="arc-team-canvas"
      role="region"
      aria-label="Team organization canvas"
    >
      <ReactFlow<MemberNode>
        colorMode={mode}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={setFlow}
        onPaneClick={() => onSelect(null)}
        onNodeClick={(_, node) => onSelect({ kind: "member", id: node.id })}
        onEdgeClick={(_, edge) => selectEdge(edge)}
        onNodesChange={(changes) => {
          const positions = new Map(
            (latest.current.presentation.members ?? []).map((position) => [
              position.memberId,
              position,
            ]),
          );
          let moved = false;
          for (const change of changes) {
            if (change.type === "select" && change.selected)
              onSelect({ kind: "member", id: change.id });
            if (change.type === "position" && change.position) {
              moved = true;
              positions.set(change.id, {
                memberId: change.id,
                ...change.position,
              });
            }
          }
          if (moved)
            onChange({
              ...latest.current,
              schemaVersion: 2,
              presentation: {
                ...latest.current.presentation,
                members: [...positions.values()],
              },
            });
        }}
        onEdgesChange={(changes) => {
          for (const change of changes)
            if (change.type === "select" && change.selected) {
              const edge = edges.find((item) => item.id === change.id);
              if (edge) selectEdge(edge);
            }
        }}
        onConnect={(connection) =>
          onConnectMembers(connection.source, connection.target)
        }
        isValidConnection={valid}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(AGENT_DRAG_TYPE)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          const agentId = event.dataTransfer.getData(AGENT_DRAG_TYPE);
          if (!flow || !agentId) return;
          event.preventDefault();
          onDropAgent(
            agentId,
            flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          );
        }}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        nodesFocusable
        edgesFocusable
        connectOnClick
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={2}
        zoomOnDoubleClick={!reducedMotion}
        panOnScroll
        attributionPosition="bottom-right"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <Panel
          position="top-left"
          className="arc-team-canvas-help text-xs text-muted-foreground"
        >
          Drag an agent here. Connect handles to add “
          {relationshipLabels[relationship].toLowerCase()}”. Arrow keys move the
          selected agent.
        </Panel>
      </ReactFlow>
    </div>
  );
}
