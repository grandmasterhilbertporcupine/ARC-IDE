import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_AGENT_DOCUMENT_CHARS } from "../contract.js";
import { AgentStoreError } from "../data.js";
import { parseAgentDocument } from "../document.js";
import type { TeamMember } from "../teams/contract.js";
import {
  resolvedExecutionSchema,
  type RunAgentSnapshot,
} from "./definition.js";

type Inheritance =
  | RunAgentSnapshot["definition"]["metadata"]["execution"]
  | Awaited<
      ReturnType<BbPluginApi["sdk"]["projects"]["defaultExecutionOptions"]>
    >
  | (NonNullable<
      Awaited<
        ReturnType<BbPluginApi["sdk"]["threads"]["defaultExecutionOptions"]>
      >
    > & { providerId: string });

export async function loadRunExecutionInheritance(
  bb: BbPluginApi,
  projectId: string,
  threadId: string,
) {
  const [defaults, thread] = await Promise.all([
    bb.sdk.projects.defaultExecutionOptions({ projectId }),
    bb.sdk.threads.get({ threadId }),
  ]);
  if (thread.projectId !== projectId)
    throw new AgentStoreError(
      "scope_denied",
      "The execution defaults belong to another project",
    );
  if (defaults !== null) return defaults;
  const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId });
  return execution === null
    ? null
    : { ...execution, providerId: thread.providerId };
}

export function resolveRunAgentSnapshot(
  definition: RunAgentSnapshot["definition"],
  inherited: Inheritance,
  modelOverride?: TeamMember["modelOverride"],
): RunAgentSnapshot {
  const execution = configuredMemberExecution(definition, modelOverride);
  const resolved = resolvedExecutionSchema.safeParse({
    providerId: execution.providerId ?? inherited?.providerId,
    model: execution.model ?? inherited?.model,
    reasoningLevel: execution.reasoningLevel ?? inherited?.reasoningLevel,
    serviceTier: execution.serviceTier ?? inherited?.serviceTier,
    permissionMode: execution.permissionMode ?? inherited?.permissionMode,
  });
  if (!resolved.success)
    throw new AgentStoreError(
      "execution_configuration_missing",
      `Choose a provider, model and execution settings for ${definition.metadata.name}, or configure the orchestrator conversation before starting this run`,
    );
  if (
    parseAgentDocument(definition.document).body.length >
    MAX_AGENT_DOCUMENT_CHARS - 1500
  )
    throw new AgentStoreError(
      "instructions_too_large",
      "Shorten this agent definition to leave room for its pinned run context",
    );
  return { definition, execution: resolved.data };
}

export function configuredMemberExecution(
  definition: RunAgentSnapshot["definition"],
  modelOverride?: TeamMember["modelOverride"],
) {
  return modelOverride === undefined
    ? definition.metadata.execution
    : { ...definition.metadata.execution, ...modelOverride };
}
