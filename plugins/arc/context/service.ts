import { createHash } from "node:crypto";
import type {
  ExperimentalHostClient,
  PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { AgentStoreError } from "../data.js";
import type { AgentActor } from "../service.js";
import type {
  contextHostRpcMethods,
  HostContextScope,
} from "../host-context-contract.js";
import {
  arcContextRpcContract,
  contextMutationRejectionCodeSchema,
  type ContextTarget,
} from "./contract.js";
import type { ContextStore } from "./data.js";

interface ContextDependencies {
  project(projectId: string): Promise<{
    id: string;
    name: string;
    kind: string;
    sources: Array<{ hostId: string; path: string; isDefault: boolean }>;
  }>;
  environment(environmentId: string): Promise<{
    projectId: string;
    hostId: string;
    status: string;
    path: string | null;
  }>;
  host: ExperimentalHostClient<typeof contextHostRpcMethods>;
  changed(projectId: string): void;
}

export function createArcContextService(
  store: ContextStore,
  deps: ContextDependencies,
) {
  function rejected(error: unknown) {
    if (!(error instanceof AgentStoreError)) throw error;
    const code = contextMutationRejectionCodeSchema.safeParse(error.code);
    if (!code.success) throw error;
    return {
      outcome: "rejected" as const,
      error: {
        code: code.data,
        message: error.message.slice(error.code.length + 2),
      },
    };
  }
  function referenceDigest(projectId: string) {
    return createHash("sha256")
      .update(
        JSON.stringify(
          store.list(projectId).map(({ id, sha256, revision, name }) => ({
            id,
            sha256,
            revision,
            name,
          })),
        ),
      )
      .digest("hex");
  }

  function handlers(
    actor: AgentActor = { kind: "user" },
    signal = new AbortController().signal,
  ): PluginRpcHandlers<typeof arcContextRpcContract> {
    async function project(projectId: string) {
      if (actor.kind !== "user")
        throw new AgentStoreError(
          "context_snapshot_required",
          "Project Context is currently a user surface; agent retrieval requires a bound execution snapshot",
        );
      signal.throwIfAborted();
      const value = await deps.project(projectId);
      if (value.id !== projectId || value.kind === "personal")
        throw new AgentStoreError(
          "scope_denied",
          "Choose a saved project for its shared Context",
        );
      return value;
    }
    async function scope(target: ContextTarget): Promise<HostContextScope> {
      const value = await project(target.projectId);
      const source = value.sources.find(
        (source) => source.hostId === target.hostId,
      );
      if (!source)
        throw new AgentStoreError(
          "scope_denied",
          "This host does not contain the selected project",
        );
      let path = source.path;
      if (target.environmentId !== null) {
        const environment = await deps.environment(target.environmentId);
        if (
          environment.projectId !== target.projectId ||
          environment.hostId !== target.hostId ||
          environment.status !== "ready" ||
          environment.path === null
        ) {
          throw new AgentStoreError(
            "scope_denied",
            "Choose a ready environment belonging to this project and host",
          );
        }
        path = environment.path;
      }
      return {
        ...target,
        path,
        referenceDigest: referenceDigest(target.projectId),
      };
    }
    const options = (target: ContextTarget) => ({
      hostId: target.hostId,
      signal,
    });
    function current<T>(selected: HostContextScope, result: T): T {
      if (referenceDigest(selected.projectId) !== selected.referenceDigest)
        throw new AgentStoreError(
          "context_changed",
          "Project references changed during this request; refresh Context and retry",
        );
      return result;
    }
    async function reindex(target: ContextTarget, operationId: string) {
      const selected = await scope(target);
      return deps.host.call(
        "startContextIndex",
        {
          scope: selected,
          operationId,
          references: store.originals(target.projectId),
        },
        options(target),
      );
    }
    return {
      async getContextSetup(input) {
        const value = await project(input.projectId);
        const source =
          input.hostId === null
            ? (value.sources.find((source) => source.isDefault) ??
              value.sources[0])
            : value.sources.find((source) => source.hostId === input.hostId);
        if (!source)
          throw new AgentStoreError(
            "project_source_missing",
            "Choose a project folder on an enrolled host",
          );
        return {
          project: { id: value.id, name: value.name },
          sources: value.sources.map(({ hostId, path }) => ({ hostId, path })),
          target: {
            projectId: value.id,
            hostId: source.hostId,
            environmentId: null,
          },
        };
      },
      async getContextStatus({ target }) {
        const selected = await scope(target);
        return current(
          selected,
          await deps.host.call(
            "getContextIndexStatus",
            { scope: selected },
            options(target),
          ),
        );
      },
      async listContextSources({ target, ...input }) {
        const selected = await scope(target);
        return current(
          selected,
          await deps.host.call(
            "listContextIndexSources",
            { ...input, scope: selected },
            options(target),
          ),
        );
      },
      async reindexContext({ target, operationId }) {
        return reindex(target, operationId);
      },
      async cancelContextIndexing({ target, operationId }) {
        return deps.host.call(
          "cancelContextIndex",
          { scope: await scope(target), operationId },
          options(target),
        );
      },
      async searchContext({ target, ...input }) {
        const selected = await scope(target);
        return current(
          selected,
          await deps.host.call(
            "searchContextIndex",
            { ...input, scope: selected },
            options(target),
          ),
        );
      },
      async readContextExcerpt({ target, ...input }) {
        const selected = await scope(target);
        return current(
          selected,
          await deps.host.call(
            "readContextIndexExcerpt",
            { ...input, scope: selected },
            options(target),
          ),
        );
      },
      async listContextReferences({ projectId }) {
        await project(projectId);
        return { sources: store.list(projectId) };
      },
      async readContextReference({ projectId, sourceId, revision }) {
        await project(projectId);
        const { text, ...source } = store.read(projectId, sourceId, revision);
        return { source, text };
      },
      async importContextSource({ target, ...input }) {
        await scope(target);
        let reference;
        try {
          reference = store.importSource({
            ...input,
            projectId: target.projectId,
          });
        } catch (error) {
          return rejected(error);
        }
        deps.changed(target.projectId);
        try {
          const status = await reindex(target, `import:${input.operationId}`);
          return { outcome: "applied", reference, status, indexError: null };
        } catch (error) {
          return {
            outcome: "applied",
            reference,
            status: null,
            indexError:
              error instanceof Error
                ? error.message
                : "The reference was saved, but indexing could not start",
          };
        }
      },
      async archiveContextReference({ target, ...input }) {
        await scope(target);
        let reference;
        try {
          reference = store.archive({ ...input, projectId: target.projectId });
        } catch (error) {
          return rejected(error);
        }
        deps.changed(target.projectId);
        try {
          const status = await reindex(target, `archive:${input.operationId}`);
          return { outcome: "applied", reference, status, indexError: null };
        } catch (error) {
          return {
            outcome: "applied",
            reference,
            status: null,
            indexError:
              error instanceof Error
                ? error.message
                : "The reference was removed, but indexing could not restart",
          };
        }
      },
    };
  }

  return {
    handlers,
    async call(
      method: string,
      input: unknown,
      actor: AgentActor,
      signal?: AbortSignal,
    ) {
      const h = handlers(actor, signal);
      switch (method) {
        case "archiveContextReference":
          return h.archiveContextReference(
            arcContextRpcContract.archiveContextReference.input.parse(input),
          );
        case "getContextSetup":
          return h.getContextSetup(
            arcContextRpcContract.getContextSetup.input.parse(input),
          );
        case "getContextStatus":
          return h.getContextStatus(
            arcContextRpcContract.getContextStatus.input.parse(input),
          );
        case "listContextSources":
          return h.listContextSources(
            arcContextRpcContract.listContextSources.input.parse(input),
          );
        case "reindexContext":
          return h.reindexContext(
            arcContextRpcContract.reindexContext.input.parse(input),
          );
        case "cancelContextIndexing":
          return h.cancelContextIndexing(
            arcContextRpcContract.cancelContextIndexing.input.parse(input),
          );
        case "searchContext":
          return h.searchContext(
            arcContextRpcContract.searchContext.input.parse(input),
          );
        case "readContextExcerpt":
          return h.readContextExcerpt(
            arcContextRpcContract.readContextExcerpt.input.parse(input),
          );
        case "listContextReferences":
          return h.listContextReferences(
            arcContextRpcContract.listContextReferences.input.parse(input),
          );
        case "readContextReference":
          return h.readContextReference(
            arcContextRpcContract.readContextReference.input.parse(input),
          );
        case "importContextSource":
          return h.importContextSource(
            arcContextRpcContract.importContextSource.input.parse(input),
          );
        default:
          throw new AgentStoreError("method_missing", "Unknown Context method");
      }
    },
  };
}
export type ArcContextService = ReturnType<typeof createArcContextService>;
