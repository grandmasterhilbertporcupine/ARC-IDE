import { z } from "zod";
import {
  directoryErrorCodeSchema,
  directoryStateSchema,
} from "../host-directory-contract.js";
import {
  gitOidSchema,
  runIdSchema,
  runtimeIdSchema,
  runtimePathSchema,
} from "./definition.js";

export const projectRunSetupRequestSchema = z
  .object({
    projectId: runtimeIdSchema,
    hostId: runtimeIdSchema.nullable().default(null),
  })
  .strict();

const source = { hostId: runtimeIdSchema, path: runtimePathSchema };
export const projectRunSetupSchema = z
  .object({
    sources: z.array(z.object(source).strict()),
    selected: z.discriminatedUnion("kind", [
      z
        .object({
          ...source,
          kind: z.literal("git"),
          head: gitOidSchema,
          clean: z.boolean(),
        })
        .strict(),
      z.object({ ...source, kind: z.literal("directory") }).strict(),
    ]),
    threads: z.array(
      z.object({ id: runtimeIdSchema, title: z.string().nullable() }).strict(),
    ),
  })
  .strict();

export const directorySetupRequestSchema = z
  .object({
    operationId: runtimeIdSchema,
    projectId: runtimeIdSchema,
    originThreadId: runtimeIdSchema,
    hostId: runtimeIdSchema,
  })
  .strict();
export type DirectorySetupRequest = z.infer<typeof directorySetupRequestSchema>;

const inspection = {
  operationId: runtimeIdSchema,
  sourceInspectionId: runtimeIdSchema,
  hostId: runtimeIdSchema,
  path: runtimePathSchema,
};
export const directorySetupSchema = z.discriminatedUnion("state", [
  z
    .object({ ...inspection, state: z.literal("consumed"), runId: runIdSchema })
    .strict(),
  z.object({ ...inspection, state: z.literal("pending") }).strict(),
  z
    .object({
      ...inspection,
      state: z.literal("ready"),
      source: directoryStateSchema,
    })
    .strict(),
  z
    .object({
      ...inspection,
      state: z.literal("failed"),
      code: directoryErrorCodeSchema,
      reason: z.string(),
    })
    .strict(),
]);
export type DirectorySetup = z.infer<typeof directorySetupSchema>;
