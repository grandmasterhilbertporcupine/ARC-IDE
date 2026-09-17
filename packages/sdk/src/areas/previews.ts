import type {
  ConfigurePreviewRequest,
  DetachPreviewRequest,
  ProjectPreview,
} from "@bb/server-contract";
import type { CreateSdkAreaArgs } from "./common.js";
export type {
  ConfigurePreviewRequest,
  DetachPreviewRequest,
  ProjectPreview,
  PreviewLaunchConfig,
} from "@bb/server-contract";

export interface ExperimentalPreviewsArea {
  get(input: { projectId: string }): Promise<ProjectPreview>;
  configure(
    input: ConfigurePreviewRequest & { projectId: string },
  ): Promise<ProjectPreview>;
  start(input: { projectId: string }): Promise<ProjectPreview>;
  stop(input: { projectId: string }): Promise<ProjectPreview>;
  restart(input: { projectId: string }): Promise<ProjectPreview>;
  detach(
    input: DetachPreviewRequest & { projectId: string },
  ): Promise<ProjectPreview>;
}

export function createPreviewsArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalPreviewsArea {
  const api = () => transport.api.v1.projects[":id"].preview;
  return {
    detach: ({ projectId, ...json }) =>
      transport.readJson(
        api().detach.$post({ param: { id: projectId }, json }),
      ),
    get: ({ projectId }) =>
      transport.readJson(api().$get({ param: { id: projectId } })),
    configure: ({ projectId, ...json }) =>
      transport.readJson(
        api().configure.$post({ param: { id: projectId }, json }),
      ),
    start: ({ projectId }) =>
      transport.readJson(
        api().start.$post({ param: { id: projectId }, json: {} }),
      ),
    stop: ({ projectId }) =>
      transport.readJson(
        api().stop.$post({ param: { id: projectId }, json: {} }),
      ),
    restart: ({ projectId }) =>
      transport.readJson(
        api().restart.$post({ param: { id: projectId }, json: {} }),
      ),
  };
}
