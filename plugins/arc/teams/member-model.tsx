import { useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import type { AgentMetadata } from "../contract.js";
import type { TeamMember } from "./contract.js";

export type MemberIdentity = {
  name: string;
  model: string;
  role?: string;
  providerId?: string | null;
  providerName?: string;
  logoUrl?: string | null;
};

export function MemberModelLabel({
  identity,
  onEdit,
}: {
  identity: MemberIdentity;
  onEdit?(): void;
}) {
  const image = identity.logoUrl
    ? `url("${identity.logoUrl.replace(/["\\]/gu, "\\$&")}")`
    : null;
  const content = (
    <>
      {image ? (
        <span
          role="img"
          aria-label={
            identity.providerName ?? identity.providerId ?? "Model provider"
          }
          className="size-4 shrink-0 bg-current"
          style={{
            maskImage: image,
            WebkitMaskImage: image,
            maskPosition: "center",
            maskRepeat: "no-repeat",
            maskSize: "contain",
          }}
        />
      ) : (
        <Icon name="Bot" className="size-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 truncate">{identity.model}</span>
      {onEdit && (
        <Icon
          name="ChevronDown"
          className="ml-auto size-3 shrink-0"
          aria-hidden
        />
      )}
    </>
  );
  return onEdit ? (
    <button
      type="button"
      className="nodrag nopan nowheel flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`Change model for ${identity.name}: ${identity.model}`}
      title={`${identity.providerName ?? identity.providerId ?? "Inherited"} · ${identity.model}`}
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {content}
    </button>
  ) : (
    <span
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={identity.model}
    >
      {content}
    </span>
  );
}

export function MemberModelEditor({
  member,
  identity,
  inherited,
  editing,
  onEdit,
  onChange,
}: {
  member: TeamMember;
  identity: MemberIdentity;
  inherited: AgentMetadata["execution"] | null;
  editing: boolean;
  onEdit(editing: boolean): void;
  onChange(member: TeamMember): void;
}) {
  const selection = member.modelOverride ?? inherited;
  return (
    <section className="space-y-2" aria-label="Member model">
      <h4 className="text-xs font-medium">Model</h4>
      {editing ? (
        <ModelChoice
          key={member.id}
          selection={selection}
          onCancel={() => onEdit(false)}
          onApply={(value) => {
            onChange({
              ...member,
              modelOverride: {
                providerId: value.providerId,
                model: value.model,
                reasoningLevel: value.reasoningLevel,
                serviceTier: value.serviceTier ?? "default",
              },
            });
            onEdit(false);
          }}
        />
      ) : (
        <MemberModelLabel identity={identity} onEdit={() => onEdit(true)} />
      )}
      <p className="text-xs text-muted-foreground">
        {member.modelOverride
          ? "Chosen for this team member."
          : "Using the published agent’s model settings."}{" "}
        Changes here keep reusable agent defaults intact.
      </p>
      {(member.modelOverride || editing) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const { modelOverride: _model, ...inheritedMember } = member;
            onChange(inheritedMember);
            onEdit(false);
          }}
        >
          Use agent default
        </Button>
      )}
    </section>
  );
}

function ModelChoice({
  selection,
  onApply,
  onCancel,
}: {
  selection: AgentMetadata["execution"] | TeamMember["modelOverride"] | null;
  onApply(value: ExperimentalProviderModelPickerValue): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState<ExperimentalProviderModelPickerValue>(
    () => ({
      providerId: selection?.providerId ?? "",
      model: selection?.model ?? "",
      reasoningLevel: selection?.reasoningLevel ?? "medium",
      serviceTier: selection?.serviceTier ?? "default",
    }),
  );
  return (
    <div className="space-y-2">
      <ProviderModelPicker
        value={value}
        onChange={setValue}
        className="h-8 max-w-full"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!value.providerId || !value.model}
          onClick={() => onApply(value)}
        >
          Apply model
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel model change
        </Button>
      </div>
    </div>
  );
}
