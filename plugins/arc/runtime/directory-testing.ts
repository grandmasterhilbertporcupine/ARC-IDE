import type { TeamDefinition } from "../teams/contract.js";
import {
  directoryRunDefinitionSchema,
  type DirectoryRunDefinition,
} from "./directory-contract.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";

export function directoryDefinitionFixture(
  update?: (team: TeamDefinition) => void,
): DirectoryRunDefinition {
  const graph = orchestratedDefinitionFixture(update);
  const { expectedHead: _head, ...request } = graph.request;
  return directoryRunDefinitionSchema.parse({
    ...graph,
    schemaVersion: 4,
    request: {
      ...request,
      sourceInspectionId: "source-inspection",
      expectedSource: {
        rootIdentity: { deviceId: "7", fileId: "11" },
        manifestDigest: graph.source.stateHash,
      },
    },
    source: {
      kind: "directory",
      path: graph.source.path,
      rootIdentity: { deviceId: "7", fileId: "11" },
      manifestDigest: graph.source.stateHash,
      entryCount: 4,
      fileBytes: 1024,
    },
  });
}
