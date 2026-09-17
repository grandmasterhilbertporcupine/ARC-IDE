import { z } from "zod";
import {
  hostLaneSchema,
  hostProcessReceiptSchema,
} from "./host-shared-contract.js";

const id = z.string().min(1).max(200);
const path = z.string().min(1).max(32_768);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const directoryInventoryLimits = Object.freeze({
  maxEntries: 100_000,
  maxFileBytes: 1_073_741_824,
  maxTotalBytes: 8_589_934_592,
  maxManifestBytes: 33_554_432,
  maxDepth: 128,
});

export const directoryRootIdentitySchema = z
  .object({
    deviceId: z.string().regex(/^\d+$/u),
    fileId: z.string().regex(/^[1-9]\d*$/u),
  })
  .strict();

export const directoryRootSchema = z
  .object({
    kind: z.literal("directory"),
    path,
    rootIdentity: directoryRootIdentitySchema,
  })
  .strict();
export type DirectoryRoot = z.infer<typeof directoryRootSchema>;

export const directoryStateSchema = directoryRootSchema
  .extend({
    manifestDigest: digest,
    entryCount: integer.max(directoryInventoryLimits.maxEntries),
    fileBytes: integer.max(directoryInventoryLimits.maxTotalBytes),
  })
  .strict();
export type DirectoryState = z.infer<typeof directoryStateSchema>;

export const directoryBindingSchema = directoryRootSchema
  .extend({
    workspaceId: id,
    originalPath: path,
    expectedManifestDigest: digest,
  })
  .strict();
export type DirectoryBinding = z.infer<typeof directoryBindingSchema>;

export const directorySnapshotSchema = z
  .object({
    kind: z.literal("directory-snapshot"),
    snapshotId: id,
    workspace: directoryBindingSchema,
    manifestDigest: digest,
  })
  .strict()
  .refine(
    (value) => value.workspace.expectedManifestDigest === value.manifestDigest,
    "Snapshot and workspace manifest identities must match.",
  );
export type DirectorySnapshot = z.infer<typeof directorySnapshotSchema>;

export const directoryValidationConsumerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setup"), operationId: id }).strict(),
  z
    .object({
      kind: z.literal("effect"),
      effectId: id,
      dispatchGeneration: integer,
    })
    .strict(),
]);
export const directoryValidationPhaseSchema = z.enum([
  "admission",
  "before-release",
  "revalidate",
]);
export const directoryScanTargetSchema = z.union([
  z.object({ kind: z.literal("path"), path }).strict(),
  directoryBindingSchema,
  directoryRootSchema,
]);

export const directoryOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("scan-directory"),
      target: directoryScanTargetSchema,
      consumer: directoryValidationConsumerSchema,
      phase: directoryValidationPhaseSchema,
      validationId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("capture-source"),
      source: directoryStateSchema,
      workspaceId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("materialize-directory"),
      source: directorySnapshotSchema,
      workspaceId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("capture-directory"),
      source: directoryBindingSchema,
      workspaceId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("check-directory"),
      workspace: directoryBindingSchema,
      snapshotId: id,
      executable: z.string().min(1).max(32_768),
      args: z.array(z.string().max(32_768)).max(256),
      timeoutMs: z.number().int().min(100).max(7_200_000),
    })
    .strict(),
]);

export const directoryEffectRequestSchema = z
  .object({
    kind: z.literal("directory"),
    runId: id,
    effectId: id,
    lane: hostLaneSchema.nullable(),
    operation: directoryOperationSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.operation.type !== "scan-directory" && request.lane === null)
      context.addIssue({
        code: "custom",
        path: ["lane"],
        message: "Directory mutations and checks require a serial lane fence.",
      });
    if (request.operation.type === "scan-directory" && request.lane !== null)
      context.addIssue({
        code: "custom",
        path: ["lane"],
        message:
          "Read-only directory inspections do not acquire a mutation lane.",
      });
  });
export type DirectoryEffectRequest = z.infer<
  typeof directoryEffectRequestSchema
>;

export const directoryErrorCodeSchema = z.enum([
  "invalid_path",
  "unsupported_link",
  "unsupported_entry",
  "inventory_limit",
  "directory_changed",
  "ownership_mismatch",
  "destination_exists",
  "git_source",
  "io_error",
  "interrupted",
  "process_failed",
]);
export type DirectoryErrorCode = z.infer<typeof directoryErrorCodeSchema>;

export const directoryArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("snapshot"), snapshot: directorySnapshotSchema })
    .strict(),
  z
    .object({
      kind: z.literal("working"),
      workspace: directoryBindingSchema,
      sourceSnapshotId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspection"),
      validationId: id,
      consumer: directoryValidationConsumerSchema,
      phase: directoryValidationPhaseSchema,
      state: directoryStateSchema,
      checkedAt: z.string(),
    })
    .strict(),
]);

export const directoryEffectReceiptSchema = z
  .object({
    kind: z.literal("directory"),
    operationType: z.enum([
      "scan-directory",
      "capture-source",
      "materialize-directory",
      "capture-directory",
      "check-directory",
    ]),
    outcome: z.enum(["succeeded", "failed", "interrupted", "invalid"]),
    errorCode: directoryErrorCodeSchema.nullable(),
    reason: z.string().nullable(),
    before: directoryStateSchema.nullable(),
    after: directoryStateSchema.nullable(),
    source: directoryStateSchema.nullable(),
    processes: z.array(hostProcessReceiptSchema),
    artifact: directoryArtifactSchema.nullable(),
    finishedAt: z.string(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.outcome === "succeeded" &&
      (receipt.errorCode !== null ||
        receipt.reason !== null ||
        receipt.after === null)
    )
      context.addIssue({
        code: "custom",
        message:
          "Successful directory effects require a verified state and no error.",
      });
    if (
      receipt.outcome !== "succeeded" &&
      (receipt.errorCode === null ||
        receipt.reason === null ||
        receipt.artifact !== null)
    )
      context.addIssue({
        code: "custom",
        message:
          "Unsuccessful directory effects require a named error and cannot publish an artifact.",
      });
  });
export type DirectoryEffectReceipt = z.infer<
  typeof directoryEffectReceiptSchema
>;

export const directoryEffectIdentitySchema = z
  .object({ runId: id, effectId: id, requestHash: digest })
  .strict();
export type DirectoryEffectIdentity = z.infer<
  typeof directoryEffectIdentitySchema
>;

export const directoryEffectRecordSchema = z
  .object({
    kind: z.literal("directory"),
    runId: id,
    effectId: id,
    requestHash: digest,
    state: z.enum(["running", "terminal", "needs-reconciliation"]),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    receipt: directoryEffectReceiptSchema.nullable(),
  })
  .strict();
export type DirectoryEffectRecord = z.infer<typeof directoryEffectRecordSchema>;

export const projectSourceKindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git"), path }).strict(),
  z.object({ kind: z.literal("directory"), path }).strict(),
]);
export type ProjectSourceKind = z.infer<typeof projectSourceKindSchema>;

export const directoryHostRpcMethods = {
  inspectProjectSource: {
    input: z.object({ path }).strict(),
    output: projectSourceKindSchema,
  },
  startDirectoryEffect: {
    input: directoryEffectRequestSchema,
    output: directoryEffectRecordSchema,
  },
  observeDirectoryEffect: {
    input: directoryEffectIdentitySchema,
    output: directoryEffectRecordSchema.nullable(),
  },
  interruptDirectoryEffect: {
    input: directoryEffectIdentitySchema,
    output: directoryEffectRecordSchema.nullable(),
  },
};
