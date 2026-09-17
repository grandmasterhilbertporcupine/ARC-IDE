import { Button } from "@bb/shared-ui/button";
import type { TeamDefinition } from "./contract.js";
import { Field, selectClass } from "./inspector.js";

export function TeamRequirements({
  definition,
  onChange,
}: {
  definition: TeamDefinition;
  onChange(definition: TeamDefinition): void;
}) {
  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Required results</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Every requirement below must be satisfied. For alternative paths,
            require at least one selected result.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              ...definition,
              graph: {
                ...definition.graph,
                requiredGates: [
                  ...definition.graph.requiredGates,
                  {
                    id: `gate_${crypto.randomUUID()}`,
                    mode: "all",
                    nodeIds: [],
                  },
                ],
              },
            })
          }
        >
          Add requirement
        </Button>
      </div>
      {definition.graph.requiredGates.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Select required stages in the inspector or add a requirement here.
        </p>
      )}
      {definition.graph.requiredGates.map((gate, index) => (
        <details key={gate.id} className="border-b pb-3" open>
          <summary className="cursor-pointer text-sm">
            Requirement {index + 1} ·{" "}
            {gate.mode === "all"
              ? "All selected stages"
              : "At least one selected stage"}
          </summary>
          <div className="mt-3 space-y-3">
            <Field label={`Requirement ${index + 1} needs`}>
              <select
                aria-label={`Requirement ${index + 1} needs`}
                className={selectClass}
                value={gate.mode}
                onChange={(event) =>
                  onChange({
                    ...definition,
                    graph: {
                      ...definition.graph,
                      requiredGates: definition.graph.requiredGates.map(
                        (item) =>
                          item.id === gate.id
                            ? {
                                ...item,
                                mode:
                                  event.target.value === "any" ? "any" : "all",
                              }
                            : item,
                      ),
                    },
                  })
                }
              >
                <option value="all">All selected stages must succeed</option>
                <option value="any">
                  At least one selected stage must succeed
                </option>
              </select>
            </Field>
            <fieldset className="grid max-h-48 gap-2 overflow-y-auto @[800px]/teams:grid-cols-2">
              <legend className="sr-only">
                Stages in requirement {index + 1}
              </legend>
              {definition.graph.nodes.map((node) => (
                <label
                  key={node.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={gate.nodeIds.includes(node.id)}
                    onChange={(event) =>
                      onChange({
                        ...definition,
                        graph: {
                          ...definition.graph,
                          requiredGates: definition.graph.requiredGates.map(
                            (item) =>
                              item.id === gate.id
                                ? {
                                    ...item,
                                    nodeIds: event.target.checked
                                      ? [...item.nodeIds, node.id]
                                      : item.nodeIds.filter(
                                          (id) => id !== node.id,
                                        ),
                                  }
                                : item,
                          ),
                        },
                      })
                    }
                  />
                  {node.label || "Unnamed stage"}
                </label>
              ))}
            </fieldset>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...definition,
                  graph: {
                    ...definition.graph,
                    requiredGates: definition.graph.requiredGates.filter(
                      (item) => item.id !== gate.id,
                    ),
                  },
                })
              }
            >
              Remove requirement
            </Button>
          </div>
        </details>
      ))}
    </section>
  );
}
