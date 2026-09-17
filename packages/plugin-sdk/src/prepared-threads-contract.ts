import type {
  ClientTurnRequestId,
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  ThreadVisibility,
} from "@bb/domain";
import type { WorkspaceArgs } from "@bb/server-contract";

export type ExperimentalPrepareThreadEnvironment =
  | { type: "reuse"; environmentId: string }
  | { type: "host"; hostId: string; workspace: WorkspaceArgs };

export interface ExperimentalPreparedThreadExecution {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier;
  permissionMode: PermissionMode;
}

export interface ExperimentalPrepareThreadRequest {
  operationId: string;
  projectId: string;
  parentThreadId: string | null;
  parentNotification?: "owner-controlled";
  executionContextId: string;
  title: string;
  visibility: ThreadVisibility;
  turnPolicy: "single" | "conversation";
  environment: ExperimentalPrepareThreadEnvironment;
  execution: ExperimentalPreparedThreadExecution;
  input: PromptInput[];
}

export interface ExperimentalPreparedThreadEnvironment {
  hostId: string;
  environmentId: string;
  path: string;
}

export interface ExperimentalPreparedThreadDispatch {
  acceptedRevision: number;
  queuedMessageId: string;
  clientTurnRequestId: ClientTurnRequestId | null;
}

export interface ExperimentalThreadPreparationIdentity {
  operationId: string;
  requestHash: string;
  threadId: string;
  revision: number;
}

export type ExperimentalThreadPreparation =
  ExperimentalThreadPreparationIdentity &
    (
      | {
          state: "reserved" | "provisioning";
          environment: ExperimentalPreparedThreadEnvironment | null;
          dispatch: null;
          reason: null;
        }
      | {
          state: "prepared";
          environment: ExperimentalPreparedThreadEnvironment;
          dispatch: null;
          reason: null;
        }
      | {
          state: "start-requested" | "started";
          environment: ExperimentalPreparedThreadEnvironment;
          dispatch: ExperimentalPreparedThreadDispatch;
          reason: null;
        }
      | {
          state: "cancelled" | "failed" | "needs-reconciliation";
          environment: ExperimentalPreparedThreadEnvironment | null;
          dispatch: ExperimentalPreparedThreadDispatch | null;
          reason: string;
        }
    );

export interface ExperimentalPreparedThreadCallOptions {
  signal?: AbortSignal;
}

export interface ExperimentalPreparedThreads {
  prepare(
    request: ExperimentalPrepareThreadRequest,
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalThreadPreparation>;
  getPreparation(
    request: { operationId: string },
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalThreadPreparation | null>;
  startPrepared(
    request: {
      operationId: string;
      expectedRevision: number;
      environment: ExperimentalPreparedThreadEnvironment;
    },
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalThreadPreparation>;
}
