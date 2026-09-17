import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
} from "../services/hosts/online-rpc.js";
import { browserRequestProblem } from "../browser-request-guard.js";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { createProjectPreviewService } from "../services/project-preview.js";

export function registerPreviewRoutes(app: Hono, deps: AppDeps): void {
  app.use("/projects/:id/preview/*", async (context, next) => {
    const problem = browserRequestProblem(context, deps, {
      requireJsonForMutation: true,
    });
    if (problem)
      throw new ApiError(
        problem.status,
        "invalid_request",
        problem.error,
        false,
      );
    await next();
  });
  const service = createProjectPreviewService({
    ...deps,
    probe: (hostId, terminalId, url) =>
      callHostRetryableOnlineRpc(deps, {
        hostId,
        timeoutMs: 10_000,
        command: { type: "terminal.probePreview", terminalId, url },
      }),
    stopOwned: (hostId, terminalId) =>
      callHostOnlineRpc(deps, {
        hostId,
        timeoutMs: 10_000,
        command: { type: "terminal.stopPreview", terminalId },
      }),
  });
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.previews;
  post(routes.detach, async (context, input) =>
    context.json(await service.detach(context.req.param("id"), input)),
  );
  get(routes.get, async (context) =>
    context.json(await service.get(context.req.param("id"))),
  );
  post(routes.configure, async (context, input) =>
    context.json(await service.configure(context.req.param("id"), input)),
  );
  post(routes.start, async (context) =>
    context.json(await service.action(context.req.param("id"), "start")),
  );
  post(routes.stop, async (context) =>
    context.json(await service.action(context.req.param("id"), "stop")),
  );
  post(routes.restart, async (context) =>
    context.json(await service.action(context.req.param("id"), "restart")),
  );
}
