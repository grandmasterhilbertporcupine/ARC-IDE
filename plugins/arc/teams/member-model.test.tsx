// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ExperimentalProviderModelPickerProps } from "@get-bb/plugin-sdk";
import { MemberModelEditor } from "./member-model.js";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_ProviderModelPicker: ({
    onChange,
  }: ExperimentalProviderModelPickerProps) => {
    useEffect(() => {
      onChange({
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "high",
      });
    }, [onChange]);
    return <span>Catalog loaded</span>;
  },
}));

afterEach(cleanup);

it("keeps automatic catalog normalization local until the user applies a model", () => {
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const member = {
    id: "reader",
    agentId: "agent-one",
    revision: 1,
    groupId: null,
  };
  render(
    <MemberModelEditor
      member={member}
      identity={{ name: "Reader", model: "Project model" }}
      inherited={null}
      editing
      onEdit={onEdit}
      onChange={onChange}
    />,
  );
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel model change" }));
  expect(onEdit).toHaveBeenCalledWith(false);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply model" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    ...member,
    modelOverride: {
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "high",
      serviceTier: "default",
    },
  });
});
