// @vitest-environment jsdom
import {
  createElement,
  type ComponentProps,
  type PropsWithChildren,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { HandleProps, NodeProps, ReactFlowProps } from "@xyflow/react";
import { TeamCanvas } from "./canvas.js";
import { teamDefinitionFixture } from "./testing.js";

const harness = vi.hoisted(() => ({ props: null as ReactFlowProps | null }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useCodeTheme: () => ({ mode: "dark" }),
}));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Background: () => null,
    Controls: () => <button>Fit view</button>,
    Panel: ({ children }: PropsWithChildren) => <div>{children}</div>,
    Handle: ({
      isConnectable,
      type,
      id,
      position: _position,
      ...props
    }: HandleProps) => (
      <div
        {...props}
        data-testid="handle"
        data-connectable={String(isConnectable)}
        data-handle-type={type}
        data-handle-id={id}
      />
    ),
    ReactFlow: (props: ReactFlowProps) => {
      harness.props = props;
      return (
        <div>
          {props.nodes?.map((node) => {
            const Renderer = props.nodeTypes?.[node.type ?? "default"];
            if (!Renderer) return null;
            const rendererProps: NodeProps = {
              id: node.id,
              data: node.data,
              type: node.type ?? "default",
              selected: node.selected ?? false,
              dragging: false,
              draggable: node.draggable ?? true,
              selectable: true,
              deletable: false,
              isConnectable: node.connectable ?? props.nodesConnectable ?? true,
              zIndex: node.zIndex ?? 0,
              positionAbsoluteX: node.position.x,
              positionAbsoluteY: node.position.y,
            };
            return createElement(Renderer, { ...rendererProps, key: node.id });
          })}
          {props.children}
          <button onClick={(event) => props.onPaneClick?.(event)}>
            Clear canvas selection
          </button>
        </div>
      );
    },
  };
});
beforeEach(() => {
  harness.props = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function state() {
  if (!harness.props) throw new Error("Canvas did not render");
  return harness.props;
}

describe("Team canvas inspection mode", () => {
  it("shows the effective model and provider icon, opens member model editing, and keeps inspection read-only", () => {
    const definition = teamDefinitionFixture("agent-one");
    definition.presentation.color = "#8b5cf6";
    const members = new Map([
      [
        "builder",
        {
          name: "Builder",
          model: "gpt-6-astra",
          providerId: "codex",
          providerName: "Codex",
          logoUrl: "/codex.svg",
        },
      ],
    ]);
    const onEditModel = vi.fn();
    const { rerender } = render(
      <TeamCanvas
        definition={definition}
        members={members}
        selection={null}
        onSelect={vi.fn()}
        onChange={vi.fn()}
        onEditModel={onEditModel}
      />,
    );
    const triggers = screen.getAllByRole("button", {
      name: "Change model for Builder: gpt-6-astra",
    });
    fireEvent.click(triggers[0]);
    expect(onEditModel).toHaveBeenCalledExactlyOnceWith("builder");
    expect(screen.getAllByRole("img", { name: "Codex" })).toHaveLength(2);
    expect(
      state().nodes?.find((node) => node.id === "stage:write")?.data.color,
    ).toBe("#8b5cf6");
    rerender(
      <TeamCanvas
        definition={definition}
        members={members}
        selection={null}
        onSelect={vi.fn()}
        mode="inspect"
        onEditModel={onEditModel}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Change model/ })).toBeNull();
    expect(screen.getAllByText("gpt-6-astra")).toHaveLength(2);
    expect(onEditModel).toHaveBeenCalledTimes(1);
  });

  it.each(["node", "edge"] as const)(
    "retains the new %s when React Flow emits paired cross-kind selection callbacks",
    (kind) => {
      const definition = teamDefinitionFixture("agent-one");
      const edgeId = definition.graph.edges[0].id;
      const onSelect = vi.fn();
      render(
        <TeamCanvas
          definition={definition}
          members={new Map()}
          selection={
            kind === "node"
              ? { kind: "edge", id: edgeId }
              : { kind: "node", id: "write" }
          }
          onSelect={onSelect}
          mode="inspect"
        />,
      );
      const flow = state();
      act(() => {
        if (kind === "node") {
          flow.onNodesChange?.([
            { type: "select", id: "stage:write", selected: true },
          ]);
          flow.onEdgesChange?.([
            { type: "select", id: edgeId, selected: false },
          ]);
        } else {
          flow.onEdgesChange?.([
            { type: "select", id: edgeId, selected: true },
          ]);
          flow.onNodesChange?.([
            { type: "select", id: "stage:write", selected: false },
          ]);
        }
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith({
        kind,
        id: kind === "node" ? "write" : edgeId,
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Clear canvas selection" }),
      );
      expect(onSelect).toHaveBeenLastCalledWith(null);
      act(() => {
        flow.onNodesChange?.([
          { type: "select", id: "stage:write", selected: false },
        ]);
        flow.onEdgesChange?.([{ type: "select", id: edgeId, selected: false }]);
      });
      expect(onSelect).toHaveBeenCalledTimes(2);
    },
  );

  it("ignores deselection of another node or edge and clears only the exact current selection", () => {
    const definition = teamDefinitionFixture("agent-one");
    const onSelect = vi.fn();
    render(
      <TeamCanvas
        definition={definition}
        members={new Map()}
        selection={{ kind: "node", id: "write" }}
        onSelect={onSelect}
        mode="inspect"
      />,
    );
    const flow = state();
    act(() =>
      flow.onNodesChange?.([
        { type: "select", id: "stage:check", selected: false },
      ]),
    );
    expect(onSelect).not.toHaveBeenCalled();
    act(() =>
      flow.onEdgesChange?.([
        { type: "select", id: "edge-current", selected: true },
      ]),
    );
    act(() =>
      flow.onEdgesChange?.([
        { type: "select", id: "edge-other", selected: false },
      ]),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      kind: "edge",
      id: "edge-current",
    });
    act(() =>
      flow.onEdgesChange?.([
        { type: "select", id: "edge-current", selected: false },
      ]),
    );
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
  it("turns off animated double-click zoom when reduced motion changes", () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
    };
    vi.stubGlobal("matchMedia", () => media);
    render(
      <TeamCanvas
        definition={teamDefinitionFixture("agent-one")}
        members={new Map()}
        selection={null}
        onSelect={vi.fn()}
        mode="inspect"
      />,
    );
    expect(state().zoomOnDoubleClick).toBe(true);
    act(() => {
      media.matches = true;
      listeners.forEach((listener) => listener());
    });
    expect(state().zoomOnDoubleClick).toBe(false);
    expect(state().fitViewOptions?.duration).toBe(0);
  });
  it("removes connection, drag, reconnect and keyboard mutation paths while retaining selection and navigation", () => {
    const definition = teamDefinitionFixture("agent-one");
    const original = structuredClone(definition);
    const onSelect = vi.fn();
    render(
      <TeamCanvas
        definition={definition}
        members={new Map()}
        selection={null}
        onSelect={onSelect}
        mode="inspect"
      />,
    );
    const flow = state();
    expect(flow.nodesDraggable).toBe(false);
    expect(flow.nodesConnectable).toBe(false);
    expect(flow.edgesReconnectable).toBe(false);
    expect(flow.connectOnClick).toBe(false);
    expect(flow.onConnect).toBeUndefined();
    expect(flow.onReconnect).toBeUndefined();
    expect(flow.isValidConnection).toBeUndefined();
    expect(flow.deleteKeyCode).toBeNull();
    expect(flow.nodesFocusable && flow.edgesFocusable && flow.panOnScroll).toBe(
      true,
    );
    expect(flow.nodes?.every((node) => node.draggable === false)).toBe(true);
    expect(flow.edges?.every((edge) => edge.reconnectable === false)).toBe(
      true,
    );
    for (const handle of screen.getAllByTestId("handle")) {
      expect(handle.tabIndex).toBe(-1);
      expect(handle.getAttribute("aria-hidden")).toBe("true");
      expect(handle.dataset.connectable).toBe("false");
    }
    act(() =>
      flow.onNodesChange?.([
        {
          type: "position",
          id: "stage:write",
          position: { x: 987, y: 654 },
          dragging: false,
        },
        { type: "select", id: "stage:write", selected: true },
      ]),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      kind: "node",
      id: "write",
    });
    expect(definition).toEqual(original);
    expect(
      state().nodes?.find((node) => node.id === "stage:write")?.position,
    ).toEqual(flow.nodes?.find((node) => node.id === "stage:write")?.position);
    expect(screen.getByRole("button", { name: "Fit view" })).toBeTruthy();
    expect(screen.queryByText(/use arrow keys to move/)).toBeNull();
  });

  it("retains measured node data and positions when selection changes", () => {
    const definition = teamDefinitionFixture("agent-one");
    const base: ComponentProps<typeof TeamCanvas> = {
      definition,
      members: new Map(),
      selection: null,
      onSelect: vi.fn(),
      mode: "inspect",
    };
    const { rerender } = render(<TeamCanvas {...base} />);
    act(() =>
      state().onNodesChange?.([
        {
          type: "dimensions",
          id: "stage:write",
          dimensions: { width: 260, height: 240 },
        },
      ]),
    );
    const first = state().nodes!;
    rerender(
      <TeamCanvas {...base} selection={{ kind: "node", id: "write" }} />,
    );
    const second = state().nodes!;
    for (const node of first) {
      const next = second.find((item) => item.id === node.id)!;
      expect(next.position).toBe(node.position);
      expect(next.data).toBe(node.data);
    }
    expect(second.find((node) => node.id === "stage:write")?.selected).toBe(
      true,
    );
    expect(second.find((node) => node.id === "stage:check")).toBe(
      first.find((node) => node.id === "stage:check"),
    );
  });

  it("preserves the editor default and persists an explicit keyboard-style position change", () => {
    const definition = teamDefinitionFixture("agent-one");
    const onChange = vi.fn();
    render(
      <TeamCanvas
        definition={definition}
        members={new Map()}
        selection={null}
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );
    const flow = state();
    expect(flow.nodesDraggable).toBe(true);
    expect(flow.onConnect).toBeTypeOf("function");
    expect(flow.onReconnect).toBeTypeOf("function");
    expect(
      screen.getAllByTestId("handle").every((handle) => handle.tabIndex === 0),
    ).toBe(true);
    act(() =>
      flow.onNodesChange?.([
        {
          type: "position",
          id: "stage:write",
          position: { x: 100, y: 110 },
          dragging: false,
        },
      ]),
    );
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0]).not.toBe(definition);
    expect(
      onChange.mock.calls[0][0].presentation.nodes.find(
        (node: { nodeId: string }) => node.nodeId === "write",
      ),
    ).not.toEqual(
      definition.presentation.nodes.find((node) => node.nodeId === "write"),
    );
  });
});
