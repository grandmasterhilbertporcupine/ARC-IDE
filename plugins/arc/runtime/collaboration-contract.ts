import { z } from "zod";
import {
  gitOidSchema,
  runtimeHashSchema,
  runtimeIdSchema,
} from "./definition.js";

export const reportSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git"), head: gitOidSchema }).strict(),
  z
    .object({
      kind: z.literal("directory"),
      snapshotId: runtimeIdSchema,
      manifestDigest: runtimeHashSchema,
    })
    .strict(),
]);
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !/^(?:[a-z]:|[\\/])/i.test(path) &&
      !path.split(/[\\/]/).includes(".."),
    "Use a relative path within the assigned workspace",
  );
export const readerReportInputSchema = z
  .object({
    operationId: runtimeIdSchema,
    findings: z.string().trim().min(1).max(8000),
    files: z
      .array(
        z.object({ path: relativePath, detail: z.string().max(500) }).strict(),
      )
      .max(30),
    coverage: z.string().trim().min(1).max(1500),
    omissions: z.string().max(1500),
    questions: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict()
  .refine(
    (report) => JSON.stringify(report).length <= 16_000,
    "Keep a handoff report within 16,000 characters",
  );
export const readerReportSchema = z
  .object({
    id: runtimeIdSchema,
    runId: runtimeIdSchema,
    effectId: runtimeIdSchema,
    memberId: runtimeIdSchema,
    source: reportSourceSchema,
    report: readerReportInputSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export const runMessageInputSchema = z
  .object({
    operationId: runtimeIdSchema,
    toMemberId: runtimeIdSchema,
    kind: z.enum(["information", "question", "reply"]),
    text: z.string().trim().min(1).max(4000),
    replyTo: runtimeIdSchema.nullable(),
  })
  .strict()
  .superRefine((message, context) => {
    if ((message.kind === "reply") !== (message.replyTo !== null))
      context.addIssue({
        code: "custom",
        path: ["replyTo"],
        message: "Only a reply must reference its original question",
      });
  });
export const runMessageSchema = z
  .object({
    id: runtimeIdSchema,
    runId: runtimeIdSchema,
    effectId: runtimeIdSchema,
    fromMemberId: runtimeIdSchema,
    message: runMessageInputSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ReaderReport = z.infer<typeof readerReportSchema>;
export type ReaderReportInput = z.infer<typeof readerReportInputSchema>;
export type RunMessage = z.infer<typeof runMessageSchema>;
export type RunMessageInput = z.infer<typeof runMessageInputSchema>;
export type ReportSource = z.infer<typeof reportSourceSchema>;
