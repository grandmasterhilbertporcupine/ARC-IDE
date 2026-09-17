import type { ClientTurnRequestId, ThreadEvent } from "@bb/domain";
import { getThreadEventScopeTurnId } from "@bb/domain";
import type { StopTurnIfCurrentArgs } from "./types.js";

interface TurnRequest {
  clientRequestId: ClientTurnRequestId;
  turnId: string | null;
  state: "pending" | "accepted" | "settled" | "unknown";
}

export class RuntimeTurnRequestState {
  private readonly requests = new Map<string, TurnRequest>();

  begin(threadId: string, clientRequestId: ClientTurnRequestId): void {
    this.requests.set(threadId, {
      clientRequestId,
      turnId: null,
      state: "pending",
    });
  }

  observe(event: ThreadEvent): void {
    const request = this.requests.get(event.threadId);
    if (!request || request.state === "settled") return;
    if (event.type === "turn/input/accepted") {
      if (request.clientRequestId !== event.clientRequestId) return;
      request.turnId = getThreadEventScopeTurnId(event.scope) ?? null;
      request.state = "accepted";
    } else if (event.type === "turn/completed") {
      if (request.turnId === getThreadEventScopeTurnId(event.scope))
        request.state = "settled";
    }
  }

  detach(threadId: string): void {
    const request = this.requests.get(threadId);
    if (request && request.state !== "settled") request.state = "unknown";
  }

  settle(args: StopTurnIfCurrentArgs, turnId: string): void {
    const request = this.requests.get(args.threadId);
    if (
      request?.clientRequestId === args.expectedClientRequestId &&
      request.turnId === turnId
    )
      request.state = "settled";
  }

  inspect(args: StopTurnIfCurrentArgs, activeTurnId: string | null) {
    const request = this.requests.get(args.threadId);
    const identity = {
      clientRequestId: request?.clientRequestId ?? null,
      turnId: request?.turnId ?? null,
    };
    if (!request) return { ...identity, status: "unknown" as const };
    if (
      request.clientRequestId !== args.expectedClientRequestId ||
      (args.expectedTurnId !== null &&
        request.turnId !== null &&
        request.turnId !== args.expectedTurnId)
    )
      return { ...identity, status: "not-current" as const };
    if (request.turnId === null)
      return { ...identity, status: "unknown" as const };
    if (request.state === "settled")
      return { ...identity, status: "already-settled" as const };
    if (request.state === "accepted" && request.turnId === activeTurnId)
      return {
        clientRequestId: request.clientRequestId,
        turnId: request.turnId,
        status: "current" as const,
      };
    return { ...identity, status: "unknown" as const };
  }

  clear(): void {
    this.requests.clear();
  }
}
