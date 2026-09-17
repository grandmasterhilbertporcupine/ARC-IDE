import type {
  ClientTurnRequestId,
  PromptInput,
  ThreadEventTurnStatus,
} from "@bb/domain";
import type {
  ExperimentalPreparedThreadEnvironment,
  ExperimentalPreparedThreadExecution,
  ExperimentalPreparedThreadCallOptions,
} from "./prepared-threads-contract.js";

export interface ExperimentalOwnedTurnIdentity {
  ownerPluginId: string;
  operationId: string;
  executionContextId: string;
  clientTurnRequestId: ClientTurnRequestId;
}

export interface ExperimentalToolInvocation {
  providerThreadId: string;
  turnId: string;
  callId: string;
  ownedTurn: ExperimentalOwnedTurnIdentity | null;
}

export interface ExperimentalPrepareTurnRequest {
  operationId: string;
  projectId: string;
  threadId: string;
  executionContextId: string;
  environment: ExperimentalPreparedThreadEnvironment;
  execution: ExperimentalPreparedThreadExecution;
  input: PromptInput[];
}

export interface ExperimentalTurnPreparation {
  operationId: string;
  requestHash: string;
  threadId: string;
  executionContextId: string;
  revision: number;
  state:
    | "prepared"
    | "start-requested"
    | "started"
    | "completed"
    | "interrupted"
    | "cancelled"
    | "failed"
    | "needs-reconciliation";
  environment: ExperimentalPreparedThreadEnvironment;
  dispatch: {
    acceptedRevision: number;
    queuedMessageId: string;
    clientTurnRequestId: ClientTurnRequestId | null;
  } | null;
  turn: {
    providerThreadId: string;
    turnId: string;
    acceptedEventId: string;
    terminalEventId: string | null;
    terminalStatus: ThreadEventTurnStatus | null;
  } | null;
  reason: string | null;
}

export interface ExperimentalPreparedTurns {
  prepare(
    request: ExperimentalPrepareTurnRequest,
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalTurnPreparation>;
  getPreparation(
    request: { operationId: string },
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalTurnPreparation | null>;
  startPrepared(
    request: { operationId: string; expectedRevision: number },
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalTurnPreparation>;
  interrupt(
    request: { operationId: string; expectedRevision: number },
    options?: ExperimentalPreparedThreadCallOptions,
  ): Promise<ExperimentalTurnPreparation>;
}
