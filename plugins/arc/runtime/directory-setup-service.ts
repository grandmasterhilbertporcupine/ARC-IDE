import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentStoreError } from "../data.js";
import { arcHostContract } from "../host-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import type { AgentActor } from "../service.js";
import type { ArcRunStore } from "./data.js";
import type { DirectoryRunRequest } from "./directory-contract.js";
import { runtimeHash } from "./hash.js";
import type { OrchestratedRunDefinition } from "./orchestrated-contract.js";
import {
  directorySetupSchema,
  type DirectorySetupRequest,
} from "./source-contract.js";

export function createDirectorySetupService(
  bb: BbPluginApi,
  store: ArcRunStore,
) {
  const host = bb.hosts.experimental_client({ contract: arcHostContract });
  return {
    async inspect(
      input: DirectorySetupRequest,
      actor: AgentActor,
      signal = new AbortController().signal,
    ) {
      signal.throwIfAborted();
      if (
        actor.kind === "agent" &&
        (actor.projectId !== input.projectId ||
          actor.threadId !== input.originThreadId)
      )
        throw new AgentStoreError(
          "scope_denied",
          "Inspect this main conversation's project folder",
        );
      const [project, parent] = await Promise.all([
        bb.sdk.projects.get({ projectId: input.projectId }),
        bb.sdk.threads.get({ threadId: input.originThreadId }),
      ]);
      if (
        project.kind === "personal" ||
        parent.projectId !== input.projectId ||
        parent.parentThreadId != null ||
        parent.experimental_executionContextId != null ||
        parent.archivedAt != null ||
        !parent.environmentId
      )
        throw new AgentStoreError(
          "scope_denied",
          "Choose an active main conversation with a ready project environment",
        );
      const source = project.sources.find(
        (value) => value.hostId === input.hostId,
      );
      if (!source)
        throw new AgentStoreError(
          "project_source_missing",
          "Choose this project's registered host",
        );
      const [environment, selected] = await Promise.all([
        bb.sdk.environments.get({ environmentId: parent.environmentId }),
        host.call(
          "inspectProjectSource",
          { path: source.path },
          { hostId: input.hostId, signal },
        ),
      ]);
      if (
        environment.projectId !== input.projectId ||
        environment.hostId !== input.hostId ||
        environment.status !== "ready" ||
        environment.path === null
      )
        throw new AgentStoreError(
          "completion_environment_changed",
          "Use the main conversation's ready project host to inspect its folder",
        );
      if (selected.kind !== "directory")
        throw new AgentStoreError(
          "git_source",
          "This project uses Git. Select its current checkout for an isolated worktree run.",
        );
      signal.throwIfAborted();
      let setup = store.directories.reserveSetup({
        ...input,
        path: selected.path,
        originEnvironment: {
          hostId: environment.hostId,
          environmentId: environment.id,
          path: environment.path,
        },
        providerId: parent.providerId,
      });
      const job = setup.job;
      if (job.operation.type !== "scan-directory")
        throw new AgentStoreError(
          "directory_setup_conflict",
          "This setup does not contain a source inspection",
        );
      if (
        setup.record?.state !== "terminal" &&
        setup.record?.state !== "needs-reconciliation"
      ) {
        const identity = {
          runId: job.runId,
          effectId: job.effectId,
          requestHash: directoryEffectRequestHash(job),
        };
        const observed = await host.call("observeDirectoryEffect", identity, {
          hostId: input.hostId,
          signal,
        });
        signal.throwIfAborted();
        const record =
          observed ??
          (await host.call("startDirectoryEffect", job, {
            hostId: input.hostId,
            signal,
          }));
        signal.throwIfAborted();
        setup = store.directories.recordSetupInspection({ ...input, record });
      }
      const common = {
        operationId: input.operationId,
        sourceInspectionId: job.operation.validationId,
        hostId: input.hostId,
        path: setup.intent.path,
      };
      if (setup.consumed !== null)
        return directorySetupSchema.parse({
          ...common,
          state: "consumed",
          runId: setup.consumed.runId,
        });
      if (setup.record?.state === "needs-reconciliation")
        return directorySetupSchema.parse({
          ...common,
          state: "failed",
          code: "interrupted",
          reason:
            "This inspection was interrupted before its result was confirmed. Refresh the folder inspection to start a new read-only scan.",
        });
      if (setup.record?.state !== "terminal")
        return directorySetupSchema.parse({ ...common, state: "pending" });
      const receipt = setup.record.receipt;
      if (receipt?.outcome !== "succeeded")
        return directorySetupSchema.parse({
          ...common,
          state: "failed",
          code: receipt?.errorCode ?? "io_error",
          reason:
            receipt?.reason ??
            "The source inspection did not retain a verified result. Refresh the folder inspection.",
        });
      if (
        receipt.artifact?.kind !== "inspection" ||
        receipt.artifact.state.path !== setup.intent.path
      )
        throw new AgentStoreError(
          "directory_setup_conflict",
          "The source inspection returned another folder identity",
        );
      return directorySetupSchema.parse({
        ...common,
        state: "ready",
        source: receipt.artifact.state,
      });
    },
    source(
      input: DirectoryRunRequest,
      completion: OrchestratedRunDefinition["completion"],
    ) {
      const setup = store.directories.getSetupByInspection(input);
      const artifact = setup?.record?.receipt?.artifact;
      if (
        !setup ||
        setup.record?.state !== "terminal" ||
        setup.record.receipt?.outcome !== "succeeded" ||
        artifact?.kind !== "inspection"
      )
        throw new AgentStoreError(
          "directory_setup_pending",
          "Finish the project folder inspection before requesting its team",
        );
      if (
        setup.intent.originThreadId !== input.originThreadId ||
        setup.intent.hostId !== input.hostId ||
        setup.intent.path !== input.path ||
        setup.intent.providerId !== completion.execution.providerId ||
        runtimeHash(setup.intent.originEnvironment) !==
          runtimeHash(completion.environment)
      )
        throw new AgentStoreError(
          "directory_setup_conflict",
          "The project folder or main conversation changed. Refresh its source inspection before starting.",
        );
      if (
        artifact.state.path !== input.path ||
        artifact.state.manifestDigest !== input.expectedSource.manifestDigest ||
        runtimeHash(artifact.state.rootIdentity) !==
          runtimeHash(input.expectedSource.rootIdentity)
      )
        throw new AgentStoreError(
          "directory_source_changed",
          "The request does not match the inspected folder contents and identity",
        );
      return artifact.state;
    },
  };
}
