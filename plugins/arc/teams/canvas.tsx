import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { usePrefersReducedMotion } from "@bb/shared-ui/hooks/use-media-query";
import type { TeamDefinition, TeamEdge, TeamNode } from "./contract.js";
import { MAX_TEAM_EDGES } from "./contract.js";
import { stageLabels, type BuilderSelection } from "./ui-data.js";
import { AGENT_DRAG_TYPE } from "./organization.js";
import { MemberModelLabel, type MemberIdentity } from "./member-model.js";
import "@xyflow/react/dist/base.css";
import "./canvas.css";

type TeamCanvasProps = {
  definition: TeamDefinition;
  members: Map<string, MemberIdentity>;
  selection: BuilderSelection;
  onSelect(selection: BuilderSelection): void;
  onDropAgent?(agentId: string, position: XYPosition): void;
  onEditModel?(memberId: string): void;
} & (
  | { mode?: "edit"; onChange(definition: TeamDefinition): void }
  | { mode: "inspect"; onChange?: never }
);

type StageFlowNode = Node<
  {
    stage: TeamNode;
    member: MemberIdentity | null;
    onEditModel?: () => void;
    color: string;
    entry: boolean;
    inspection: boolean;
  },
  "team-stage"
>;
type GroupFlowNode = Node<
  { name: string; color: string; inspection: boolean },
  "team-group"
>;
type CanvasNode = StageFlowNode | GroupFlowNode;
type GroupRect = TeamDefinition["presentation"]["groups"][number];
type StageSize = { width: number; height: number };
type TeamColorStyle = CSSProperties & { "--arc-team-color": string };

const stageFlowId = (id: string) => `stage:${id}`;
const groupFlowId = (id: string) => `group:${id}`;
const fitOptions = { padding: 0.18, maxZoom: 1, duration: 0 };
const edgeDefaults = { type: "smoothstep", zIndex: 1 };
const stageWidth = 260;
const defaultStageSize = { width: stageWidth, height: 144 };
const noStageSizes = new Map<string, StageSize>();
const handleLabels: Record<TeamEdge["sourceHandle"], string> = {
  next: "Next",
  true: "True",
  false: "False",
  repaired: "Repaired",
  exhausted: "Exhausted",
};
const outcomeLabels: Record<TeamEdge["requiredOutcome"], string> = {
  succeeded: "on success",
  failed: "on failure",
  completed: "on completion",
};

function stageMemberId(node: TeamNode): string | null {
  switch (node.kind) {
    case "agent":
    case "review":
      return node.memberId;
    case "repair":
      return node.body.memberId;
    case "delegation":
      return node.requesterMemberId;
    default:
      return null;
  }
}

function outputHandles(node: TeamNode): TeamEdge["sourceHandle"][] {
  if (node.kind === "condition") return ["true", "false"];
  if (node.kind === "repair") return ["repaired", "exhausted"];
  return ["next"];
}

export function layoutTeamCanvas(
  definition: TeamDefinition,
  stageSizes: ReadonlyMap<string, StageSize> = noStageSizes,
) {
  const groups = new Map(definition.groups.map((group) => [group.id, group]));
  const groupParents = new Map<string, string | null>();
  const groupRects = new Map<string, GroupRect>();
  const savedGroups = new Map(
    definition.presentation.groups.map((item) => [item.groupId, item]),
  );
  definition.groups.forEach((group, index) => {
    let parent = group.parentGroupId;
    const visited = new Set([group.id]);
    while (parent !== null && groups.has(parent)) {
      if (visited.has(parent)) {
        groupParents.set(group.id, null);
        break;
      }
      visited.add(parent);
      parent = groups.get(parent)?.parentGroupId ?? null;
    }
    if (!groupParents.has(group.id))
      groupParents.set(
        group.id,
        group.parentGroupId !== null && groups.has(group.parentGroupId)
          ? group.parentGroupId
          : null,
      );
    groupRects.set(
      group.id,
      savedGroups.get(group.id) ?? {
        groupId: group.id,
        x: (index % 2) * 800,
        y: Math.floor(index / 2) * 560,
        width: 720,
        height: 480,
      },
    );
  });
  const memberGroups = new Map(
    definition.members.map((member) => [member.id, member.groupId]),
  );
  const stageParents = new Map<string, string | null>();
  const stagePositions = new Map<string, XYPosition>();
  const savedNodes = new Map(
    definition.presentation.nodes.map((item) => [item.nodeId, item]),
  );
  const counts = new Map<string | null, number>();
  definition.graph.nodes.forEach((node) => {
    const memberId = stageMemberId(node);
    const memberGroup =
      memberId === null ? null : (memberGroups.get(memberId) ?? null);
    const parent =
      memberGroup !== null && groups.has(memberGroup) ? memberGroup : null;
    stageParents.set(node.id, parent);
    const index = counts.get(parent) ?? 0;
    counts.set(parent, index + 1);
    const origin = parent === null ? { x: 0, y: 0 } : groupRects.get(parent)!;
    stagePositions.set(
      node.id,
      savedNodes.get(node.id) ?? {
        x: origin.x + 40 + (index % 2) * 320,
        y: origin.y + 80 + Math.floor(index / 2) * 200,
      },
    );
  });
  const measured = new Set<string>();
  const emptyGroups = new Set<string>();
  function sizeGroup(id: string): GroupRect {
    const existing = groupRects.get(id)!;
    if (measured.has(id)) return existing;
    measured.add(id);
    const contents: (XYPosition & StageSize)[] = [];
    const emptyChildren: string[] = [];
    for (const [childId, parentId] of groupParents)
      if (parentId === id) {
        const child = sizeGroup(childId);
        if (emptyGroups.has(childId)) emptyChildren.push(childId);
        else contents.push(child);
      }
    for (const [nodeId, parentId] of stageParents)
      if (parentId === id)
        contents.push({
          ...stagePositions.get(nodeId)!,
          ...(stageSizes.get(nodeId) ?? defaultStageSize),
        });
    let emptyX = contents.length
      ? Math.max(...contents.map((item) => item.x + item.width)) + 40
      : existing.x + 40;
    const emptyY = contents.length
      ? Math.min(...contents.map((item) => item.y))
      : existing.y + 64;
    for (const childId of emptyChildren) {
      const child = { ...groupRects.get(childId)!, x: emptyX, y: emptyY };
      groupRects.set(childId, child);
      contents.push(child);
      emptyX += child.width + 40;
    }
    if (savedGroups.has(id)) return existing;
    if (contents.length === 0) {
      const rect = { ...existing, width: 320, height: 200 };
      emptyGroups.add(id);
      groupRects.set(id, rect);
      return rect;
    }
    const left = Math.min(...contents.map((item) => item.x));
    const top = Math.min(...contents.map((item) => item.y));
    const right = Math.max(...contents.map((item) => item.x + item.width));
    const bottom = Math.max(...contents.map((item) => item.y + item.height));
    const rect = {
      groupId: id,
      x: left - 40,
      y: top - 64,
      width: Math.max(320, right - left + 80),
      height: Math.max(160, bottom - top + 104),
    };
    groupRects.set(id, rect);
    return rect;
  }
  for (const group of definition.groups) sizeGroup(group.id);
  const occupied = [...groupRects.values()].filter(
    (group) =>
      groupParents.get(group.groupId) === null &&
      !emptyGroups.has(group.groupId),
  );
  const occupiedBounds: (XYPosition & StageSize)[] = [...occupied];
  for (const [nodeId, parentId] of stageParents)
    if (parentId === null)
      occupiedBounds.push({
        ...stagePositions.get(nodeId)!,
        ...(stageSizes.get(nodeId) ?? defaultStageSize),
      });
  let emptyX = occupiedBounds.length
    ? Math.max(...occupiedBounds.map((item) => item.x + item.width)) + 80
    : 0;
  const emptyY = occupiedBounds.length
    ? Math.min(...occupiedBounds.map((item) => item.y))
    : 0;
  for (const id of emptyGroups)
    if (groupParents.get(id) === null) {
      const rect = { ...groupRects.get(id)!, x: emptyX, y: emptyY };
      groupRects.set(id, rect);
      emptyX += rect.width + 80;
    }
  return { groups, groupParents, groupRects, stageParents, stagePositions };
}

export function moveTeamCanvasNodes(
  definition: TeamDefinition,
  changes: NodeChange<CanvasNode>[],
  stageSizes: ReadonlyMap<string, StageSize> = noStageSizes,
): TeamDefinition {
  const moved = new Map<string, XYPosition>();
  for (const change of changes)
    if (change.type === "position" && change.position)
      moved.set(change.id, change.position);
  if (moved.size === 0) return definition;
  const layout = layoutTeamCanvas(definition, stageSizes);
  const nextGroups = new Map<string, GroupRect>();
  function moveGroup(id: string): GroupRect {
    const existing = nextGroups.get(id);
    if (existing) return existing;
    const original = layout.groupRects.get(id)!;
    const parentId = layout.groupParents.get(id) ?? null;
    const parentBefore =
      parentId === null ? { x: 0, y: 0 } : layout.groupRects.get(parentId)!;
    const parentAfter =
      parentId === null ? { x: 0, y: 0 } : moveGroup(parentId);
    const relative = moved.get(groupFlowId(id)) ?? {
      x: original.x - parentBefore.x,
      y: original.y - parentBefore.y,
    };
    const next = {
      ...original,
      x: parentAfter.x + relative.x,
      y: parentAfter.y + relative.y,
    };
    nextGroups.set(id, next);
    return next;
  }
  const groups = definition.groups.map((group) => moveGroup(group.id));
  const nodes = definition.graph.nodes.map((node) => {
    const original = layout.stagePositions.get(node.id)!;
    const parentId = layout.stageParents.get(node.id) ?? null;
    const parentBefore =
      parentId === null ? { x: 0, y: 0 } : layout.groupRects.get(parentId)!;
    const parentAfter =
      parentId === null ? { x: 0, y: 0 } : nextGroups.get(parentId)!;
    const relative = moved.get(stageFlowId(node.id)) ?? {
      x: original.x - parentBefore.x,
      y: original.y - parentBefore.y,
    };
    return {
      nodeId: node.id,
      x: parentAfter.x + relative.x,
      y: parentAfter.y + relative.y,
    };
  });
  const savedGroups = new Set(
    definition.presentation.groups.map((group) => group.groupId),
  );
  const persistedGroups = groups.filter((group) => {
    if (savedGroups.has(group.groupId)) return true;
    let id: string | null = group.groupId;
    while (id !== null) {
      if (moved.has(groupFlowId(id))) return true;
      id = layout.groupParents.get(id) ?? null;
    }
    return false;
  });
  if (
    [...groups, ...nodes].some(
      ({ x, y }) =>
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        Math.abs(x) > 100000 ||
        Math.abs(y) > 100000,
    ) ||
    persistedGroups.some(
      ({ width, height }) => width > 100000 || height > 100000,
    )
  )
    return definition;
  return {
    ...definition,
    presentation: {
      ...definition.presentation,
      groups: persistedGroups,
      nodes,
    },
  };
}

function connectionParts(
  definition: TeamDefinition,
  connection: Connection | Edge,
) {
  const source = definition.graph.nodes.find(
    (node) => stageFlowId(node.id) === connection.source,
  );
  const target = definition.graph.nodes.find(
    (node) => stageFlowId(node.id) === connection.target,
  );
  if (
    !source ||
    !target ||
    source.id === target.id ||
    connection.targetHandle !== "in"
  )
    return null;
  const sourceHandle = outputHandles(source).find(
    (handle) => handle === connection.sourceHandle,
  );
  return sourceHandle === undefined
    ? null
    : { source: source.id, target: target.id, sourceHandle };
}

export function connectTeamCanvasEdge(
  definition: TeamDefinition,
  connection: Connection,
  existingId: string | null = null,
): TeamDefinition {
  const parts = connectionParts(definition, connection);
  if (parts === null) return definition;
  const existing =
    existingId === null
      ? null
      : definition.graph.edges.find((edge) => edge.id === existingId);
  if (existingId !== null && !existing) return definition;
  if (!existing && definition.graph.edges.length >= MAX_TEAM_EDGES)
    return definition;
  if (
    definition.graph.edges.some(
      (edge) =>
        edge.id !== existingId &&
        edge.source === parts.source &&
        edge.target === parts.target &&
        edge.sourceHandle === parts.sourceHandle,
    )
  )
    return definition;
  const edge: TeamEdge = existing
    ? { ...existing, ...parts }
    : {
        id: `edge_${crypto.randomUUID()}`,
        ...parts,
        requiredOutcome:
          parts.sourceHandle === "exhausted" ? "failed" : "succeeded",
      };
  const edges = existing
    ? definition.graph.edges.map((item) =>
        item.id === existing.id ? edge : item,
      )
    : [...definition.graph.edges, edge];
  return { ...definition, graph: { ...definition.graph, edges } };
}

function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.click();
}

const StageRenderer = memo(function StageRenderer({
  data,
  selected,
  isConnectable,
}: NodeProps<StageFlowNode>) {
  const handles = outputHandles(data.stage);
  const style: TeamColorStyle = { "--arc-team-color": data.color };
  return (
    <div className="arc-team-stage" data-selected={selected} style={style}>
      <Handle
        type="target"
        id="in"
        position={Position.Top}
        isConnectable={isConnectable}
        role={data.inspection ? undefined : "button"}
        tabIndex={data.inspection ? -1 : 0}
        aria-hidden={data.inspection || undefined}
        aria-label={`${data.stage.label}: input`}
        onKeyDown={data.inspection ? undefined : handleKeyDown}
      />
      <div className="arc-team-stage-content">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{stageLabels[data.stage.kind]}</span>
          {data.entry ? <span>Entry</span> : null}
        </div>
        <div className="arc-team-stage-label text-sm font-medium">
          {data.stage.label}
        </div>
        {data.member ? (
          <div className="space-y-1">
            <p className="truncate text-xs text-muted-foreground">
              {data.member.name}
            </p>
            <MemberModelLabel
              identity={data.member}
              onEdit={data.inspection ? undefined : data.onEditModel}
            />
          </div>
        ) : stageMemberId(data.stage) !== null ? (
          <div className="text-xs text-warning-text">
            {data.inspection ? "Saved agent unavailable" : "Assign an agent"}
          </div>
        ) : null}
      </div>
      <div className="arc-team-stage-outputs text-xs text-muted-foreground">
        {handles.map((handle, index) => (
          <div className="arc-team-stage-output" key={handle}>
            <span>{handleLabels[handle]}</span>
            <Handle
              type="source"
              id={handle}
              position={Position.Bottom}
              style={{ left: `${((index + 0.5) / handles.length) * 100}%` }}
              isConnectable={isConnectable}
              role={data.inspection ? undefined : "button"}
              tabIndex={data.inspection ? -1 : 0}
              aria-hidden={data.inspection || undefined}
              aria-label={`${data.stage.label}: ${handleLabels[handle]} output`}
              onKeyDown={data.inspection ? undefined : handleKeyDown}
            />
          </div>
        ))}
      </div>
    </div>
  );
});

const GroupRenderer = memo(function GroupRenderer({
  data,
  selected,
}: NodeProps<GroupFlowNode>) {
  const style: TeamColorStyle = { "--arc-team-color": data.color };
  return (
    <div className="arc-team-group" data-selected={selected} style={style}>
      <div
        className="arc-team-group-heading text-sm font-medium"
        style={data.inspection ? { cursor: "pointer" } : undefined}
      >
        <span className="truncate">{data.name}</span>
        <span className="text-xs font-normal text-muted-foreground">Group</span>
      </div>
    </div>
  );
});

const nodeTypes = { "team-stage": StageRenderer, "team-group": GroupRenderer };

function buildCanvasNodes(
  definition: TeamDefinition,
  members: TeamCanvasProps["members"],
  layout: ReturnType<typeof layoutTeamCanvas>,
  inspection: boolean,
  onEditModel?: (memberId: string) => void,
): CanvasNode[] {
  const nodes: CanvasNode[] = [];
  const added = new Set<string>();
  function addGroup(id: string) {
    if (added.has(id)) return;
    const group = layout.groups.get(id)!;
    const rect = layout.groupRects.get(id)!;
    const parentId = layout.groupParents.get(id) ?? null;
    if (parentId !== null) addGroup(parentId);
    const parent =
      parentId === null ? { x: 0, y: 0 } : layout.groupRects.get(parentId)!;
    nodes.push({
      id: groupFlowId(id),
      type: "team-group",
      data: { name: group.name, color: group.color, inspection },
      position: { x: rect.x - parent.x, y: rect.y - parent.y },
      ...(parentId !== null ? { parentId: groupFlowId(parentId) } : {}),
      style: { width: rect.width, height: rect.height },
      width: rect.width,
      height: rect.height,
      dragHandle: ".arc-team-group-heading",
      selected: false,
      draggable: !inspection,
      deletable: false,
      connectable: false,
      ariaLabel: `Group: ${group.name}. Organizational grouping only.`,
    });
    added.add(id);
  }
  for (const group of definition.groups) addGroup(group.id);
  for (const stage of definition.graph.nodes) {
    const parentId = layout.stageParents.get(stage.id) ?? null;
    const parent =
      parentId === null ? { x: 0, y: 0 } : layout.groupRects.get(parentId)!;
    const position = layout.stagePositions.get(stage.id)!;
    const memberId = stageMemberId(stage);
    const member = memberId === null ? null : (members.get(memberId) ?? null);
    nodes.push({
      id: stageFlowId(stage.id),
      type: "team-stage",
      data: {
        stage,
        member,
        ...(memberId !== null && onEditModel && !inspection
          ? { onEditModel: () => onEditModel(memberId) }
          : {}),
        color:
          definition.presentation.color ??
          (parentId === null
            ? "var(--border)"
            : layout.groups.get(parentId)!.color),
        entry: definition.graph.entryNodeIds.includes(stage.id),
        inspection,
      },
      position: { x: position.x - parent.x, y: position.y - parent.y },
      ...(parentId !== null ? { parentId: groupFlowId(parentId) } : {}),
      width: stageWidth,
      style: { width: stageWidth },
      zIndex: 2,
      selected: false,
      draggable: !inspection,
      connectable: !inspection,
      deletable: false,
      ariaLabel: `${stage.label}. ${stageLabels[stage.kind]}${member ? `. ${member.name}, ${member.model}` : ""}`,
    });
  }
  return nodes;
}

export function TeamCanvas({
  definition,
  members,
  selection,
  onSelect,
  onChange,
  onDropAgent,
  onEditModel,
  mode: interaction = "edit",
}: TeamCanvasProps) {
  const inspection = interaction === "inspect";
  const { mode } = experimental_useCodeTheme();
  const reducedMotion = usePrefersReducedMotion();
  const [stageSizes, setStageSizes] = useState(noStageSizes);
  const [flow, setFlow] = useState<ReactFlowInstance<CanvasNode> | null>(null);
  const definitionRef = useRef(definition);
  const selectionRef = useRef(selection);
  useLayoutEffect(() => {
    definitionRef.current = definition;
  }, [definition]);
  useLayoutEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  const select = useCallback(
    (value: BuilderSelection) => {
      selectionRef.current = value;
      onSelect(value);
    },
    [onSelect],
  );
  const layout = useMemo(
    () => layoutTeamCanvas(definition, stageSizes),
    [definition, stageSizes],
  );
  const baseNodes = useMemo(
    () =>
      buildCanvasNodes(definition, members, layout, inspection, onEditModel),
    [definition, members, layout, inspection, onEditModel],
  );
  const nodes = useMemo(() => {
    const selectedId =
      selection?.kind === "node"
        ? stageFlowId(selection.id)
        : selection?.kind === "group"
          ? groupFlowId(selection.id)
          : null;
    return baseNodes.map((node) =>
      node.id === selectedId
        ? { ...node, selected: true, ariaLabel: `${node.ariaLabel}. Selected` }
        : node,
    );
  }, [baseNodes, selection]);
  const stageMap = useMemo(
    () => new Map(definition.graph.nodes.map((node) => [node.id, node])),
    [definition.graph.nodes],
  );
  const edges = useMemo<Edge[]>(
    () =>
      definition.graph.edges.map((edge) => {
        const source = stageMap.get(edge.source)?.label ?? edge.source;
        const target = stageMap.get(edge.target)?.label ?? edge.target;
        const selected = selection?.kind === "edge" && selection.id === edge.id;
        const label = `${handleLabels[edge.sourceHandle]} · ${outcomeLabels[edge.requiredOutcome]}`;
        return {
          id: edge.id,
          source: stageFlowId(edge.source),
          target: stageFlowId(edge.target),
          sourceHandle: edge.sourceHandle,
          targetHandle: "in",
          selected,
          deletable: false,
          reconnectable: !inspection,
          markerEnd: { type: MarkerType.ArrowClosed },
          ariaRole: "button",
          ariaLabel: `${source} to ${target}: ${label}`,
          domAttributes: { "aria-pressed": selected },
        };
      }),
    [definition.graph.edges, stageMap, selection, inspection],
  );
  useEffect(() => {
    if (!inspection || !flow || !selection) return;
    const edge =
      selection.kind === "edge"
        ? definition.graph.edges.find((edge) => edge.id === selection.id)
        : null;
    const ids =
      selection.kind === "node"
        ? [stageFlowId(selection.id)]
        : selection.kind === "group"
          ? [groupFlowId(selection.id)]
          : edge
            ? [stageFlowId(edge.source), stageFlowId(edge.target)]
            : [];
    if (ids.length > 0)
      void flow.fitView({
        nodes: ids.map((id) => ({ id })),
        padding: 0.35,
        maxZoom: 1,
        duration: 0,
      });
  }, [inspection, flow, selection, definition.graph.edges]);
  const selectedEdge = edges.find((edge) => edge.selected);
  const commit = useCallback(
    (next: TeamDefinition) => {
      if (!onChange) return;
      if (next === definitionRef.current) return;
      definitionRef.current = next;
      onChange(next);
    },
    [onChange],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setStageSizes((previous) => {
        let next = previous;
        for (const change of changes) {
          if (
            change.type !== "dimensions" ||
            !change.id.startsWith("stage:") ||
            !change.dimensions
          )
            continue;
          const id = change.id.slice(6);
          const size = previous.get(id);
          if (
            size?.width === change.dimensions.width &&
            size?.height === change.dimensions.height
          )
            continue;
          if (next === previous) next = new Map(previous);
          next.set(id, change.dimensions);
        }
        return next;
      });
      if (!inspection)
        commit(moveTeamCanvasNodes(definitionRef.current, changes, stageSizes));
      const selected = changes.find(
        (change) => change.type === "select" && change.selected,
      );
      const current = selectionRef.current;
      const currentId =
        current?.kind === "node"
          ? stageFlowId(current.id)
          : current?.kind === "group"
            ? groupFlowId(current.id)
            : null;
      if (selected?.type === "select")
        select(
          selected.id.startsWith("group:")
            ? { kind: "group", id: selected.id.slice(6) }
            : { kind: "node", id: selected.id.slice(6) },
        );
      else if (
        currentId !== null &&
        changes.some(
          (change) =>
            change.type === "select" &&
            !change.selected &&
            change.id === currentId,
        )
      )
        select(null);
    },
    [commit, select, stageSizes, inspection],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const selected = changes.find(
        (change) => change.type === "select" && change.selected,
      );
      const current = selectionRef.current;
      if (selected?.type === "select")
        select({ kind: "edge", id: selected.id });
      else if (
        current?.kind === "edge" &&
        changes.some(
          (change) =>
            change.type === "select" &&
            !change.selected &&
            change.id === current.id,
        )
      )
        select(null);
    },
    [select],
  );
  const onConnect = useCallback(
    (connection: Connection) =>
      commit(connectTeamCanvasEdge(definitionRef.current, connection)),
    [commit],
  );
  const onReconnect = useCallback(
    (edge: Edge, connection: Connection) =>
      commit(connectTeamCanvasEdge(definitionRef.current, connection, edge.id)),
    [commit],
  );
  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      connectionParts(definitionRef.current, connection) !== null,
    [],
  );
  return (
    <div
      className="arc-team-canvas"
      role="region"
      aria-label={
        inspection ? "Saved team workflow canvas" : "Team workflow canvas"
      }
    >
      <ReactFlow<CanvasNode>
        colorMode={mode}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={edgeDefaults}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={inspection ? undefined : onConnect}
        onReconnect={inspection ? undefined : onReconnect}
        isValidConnection={inspection ? undefined : isValidConnection}
        onInit={setFlow}
        onDragOver={
          inspection
            ? undefined
            : (event) => {
                if (event.dataTransfer.types.includes(AGENT_DRAG_TYPE)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }
        }
        onDrop={
          inspection
            ? undefined
            : (event) => {
                const agentId = event.dataTransfer.getData(AGENT_DRAG_TYPE);
                if (!flow || !agentId || !onDropAgent) return;
                event.preventDefault();
                onDropAgent(
                  agentId,
                  flow.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                );
              }
        }
        onPaneClick={() => select(null)}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        nodesFocusable
        edgesFocusable
        nodesDraggable={!inspection}
        nodesConnectable={!inspection}
        edgesReconnectable={!inspection}
        disableKeyboardA11y={false}
        autoPanOnNodeFocus
        connectOnClick={!inspection}
        zoomOnDoubleClick={!reducedMotion}
        fitView
        fitViewOptions={fitOptions}
        minZoom={0.15}
        maxZoom={2}
        panOnScroll
        preventScrolling
        attributionPosition="bottom-right"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <Panel
          position="top-left"
          className="arc-team-canvas-help text-xs text-muted-foreground"
        >
          {selectedEdge ? (
            <>
              <span className="block font-medium text-foreground">
                Selected connection
              </span>
              {selectedEdge.ariaLabel}
            </>
          ) : inspection ? (
            <>
              Saved plan. Select a stage or connection to inspect it. Pan, zoom
              or fit to navigate.
            </>
          ) : (
            <>
              Connect an output to an input. Select a stage and use arrow keys
              to move it.
            </>
          )}
        </Panel>
      </ReactFlow>
    </div>
  );
}
