import type { TeamDefinition, TeamNode } from "../teams/contract.js";

type Diagnostic = { code: string; message: string; nodeIds: string[] };
type Outcomes = Map<string, Set<"succeeded" | "failed">>;

export function validateDirectoryTeamGraph(team: TeamDefinition): {
  valid: boolean;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  for (const node of team.graph.nodes) {
    if (node.kind === "parallel")
      diagnostics.push({
        code: "directory_parallel_stage_unavailable",
        message:
          "This directory backend requires an explicitly serial team; parallel stages remain available for Git projects.",
        nodeIds: [node.id],
      });
    if (node.kind === "integration")
      diagnostics.push({
        code: "directory_integration_unavailable",
        message:
          "Directory runs preserve a serial candidate chain and cannot integrate Git branches.",
        nodeIds: [node.id],
      });
  }
  const nodes = new Map(team.graph.nodes.map((node) => [node.id, node]));
  const remaining = new Set(nodes.keys());
  const ancestors = new Map<string, Set<string>>();
  const guards = new Map<string, Map<string, string>>();
  const outcomes = new Map<string, Outcomes>();
  const lineage = new Map<string, Set<string>>();
  const writes = (node: TeamNode) =>
    node.kind === "repair" ||
    ((node.kind === "agent" || node.kind === "delegation") &&
      node.access === "write");
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        team.graph.edges
          .filter((edge) => edge.target === id)
          .every((edge) => !remaining.has(edge.source)),
      )
      .sort();
    if (!ready.length) {
      diagnostics.push({
        code: "graph_cycle",
        message: "The execution graph must be acyclic.",
        nodeIds: [...remaining],
      });
      break;
    }
    for (const id of ready) {
      const node = nodes.get(id)!;
      const edges = team.graph.edges.filter((edge) => edge.target === id);
      const selected =
        node.kind === "join" && node.mode === "selected"
          ? node.decisionNodeId
          : null;
      const nodeGuards = new Map<string, string>();
      const inputGuards = edges.map((edge) => {
        const values = new Map(guards.get(edge.source));
        if (edge.sourceHandle !== "next")
          values.set(edge.source, edge.sourceHandle);
        return values;
      });
      for (const values of inputGuards) {
        for (const [source, output] of values) {
          if (source === selected) continue;
          if (
            selected !== null &&
            team.schemaVersion === 2 &&
            !inputGuards.every((entry) => entry.get(source) === output)
          )
            continue;
          if (nodeGuards.has(source) && nodeGuards.get(source) !== output)
            diagnostics.push({
              code: "exclusive_graph_inputs",
              message:
                "Alternative writing paths require an explicit selected join.",
              nodeIds: [id],
            });
          nodeGuards.set(source, output);
        }
      }
      guards.set(id, nodeGuards);
      ancestors.set(
        id,
        new Set(
          edges.flatMap((edge) => [
            edge.source,
            ...(ancestors.get(edge.source) ?? []),
          ]),
        ),
      );
      const edgeOutcomes = edges.map((edge) => {
        const values = new Map(outcomes.get(edge.source));
        values.set(
          edge.source,
          new Set<"succeeded" | "failed">(
            edge.requiredOutcome === "completed"
              ? ["succeeded", "failed"]
              : [edge.requiredOutcome],
          ),
        );
        return values;
      });
      const nodeOutcomes: Outcomes = new Map();
      for (const values of edgeOutcomes)
        for (const [source, possible] of values) {
          if (selected !== null) {
            if (edgeOutcomes.every((entry) => entry.has(source)))
              nodeOutcomes.set(
                source,
                new Set(
                  edgeOutcomes.flatMap((entry) => [
                    ...(entry.get(source) ?? []),
                  ]),
                ),
              );
          } else {
            const prior = nodeOutcomes.get(source);
            nodeOutcomes.set(
              source,
              new Set(
                [...possible].filter(
                  (value) => prior === undefined || prior.has(value),
                ),
              ),
            );
          }
        }
      outcomes.set(id, nodeOutcomes);
      const inherited =
        node.kind === "repair"
          ? node.checkNodeId
          : "candidate" in node && node.candidate?.kind === "node"
            ? node.candidate.nodeId
            : null;
      const currentLineage = new Set(
        selected !== null && team.schemaVersion === 2
          ? edges.flatMap((edge) => [...(lineage.get(edge.source) ?? [])])
          : inherited === null
            ? []
            : lineage.get(inherited),
      );
      if (writes(node)) currentLineage.add(id);
      lineage.set(id, currentLineage);
      remaining.delete(id);
    }
  }
  const writers = team.graph.nodes.filter(writes);
  for (let index = 0; index < writers.length; index++) {
    const left = writers[index];
    for (const right of writers.slice(index + 1)) {
      const compatible =
        [...(guards.get(left.id) ?? [])].every(
          ([id, output]) =>
            !guards.get(right.id)?.has(id) ||
            guards.get(right.id)?.get(id) === output,
        ) &&
        [...(outcomes.get(left.id) ?? [])].every(
          ([id, values]) =>
            !outcomes.get(right.id)?.has(id) ||
            [...values].some((value) =>
              outcomes.get(right.id)?.get(id)?.has(value),
            ),
        );
      if (!compatible) continue;
      const ordered = ancestors.get(right.id)?.has(left.id)
        ? [left, right]
        : ancestors.get(left.id)?.has(right.id)
          ? [right, left]
          : null;
      if (!ordered)
        diagnostics.push({
          code: "directory_parallel_writes",
          message:
            "Connect these directory writing stages serially, choose mutually exclusive branches, or use a Git project.",
          nodeIds: [left.id, right.id],
        });
      else if (!lineage.get(ordered[1].id)?.has(ordered[0].id))
        diagnostics.push({
          code: "directory_candidate_lineage_conflict",
          message:
            "This writing stage discards an earlier selected directory result. Use the preceding stage's candidate.",
          nodeIds: ordered.map((node) => node.id),
        });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
