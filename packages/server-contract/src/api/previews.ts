import { z } from "zod";
import { terminalSessionSchema } from "./terminals.js";

export const previewLaunchConfigSchema = z
  .object({
    hostId: z.string().min(1),
    cwd: z.string().trim().min(1).max(4096),
    command: z.string().trim().min(1).max(10_000),
    url: z
      .string()
      .max(4096)
      .refine((value) => {
        if (value === "") return true;
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }, "Use an HTTP(S) URL without credentials, or leave it blank")
      .default(""),
  })
  .strict();
export type PreviewLaunchConfig = z.infer<typeof previewLaunchConfigSchema>;

export const configurePreviewRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    config: previewLaunchConfigSchema,
  })
  .strict();
export type ConfigurePreviewRequest = z.infer<
  typeof configurePreviewRequestSchema
>;
export const previewActionRequestSchema = z.object({}).strict();
export const detachPreviewRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    terminalId: z.string().min(1),
    acknowledgeUnconfirmedProcess: z.literal(true),
  })
  .strict();
export type DetachPreviewRequest = z.infer<typeof detachPreviewRequestSchema>;
export const detachedPreviewSessionSchema = z
  .object({
    terminalId: z.string().min(1),
    config: previewLaunchConfigSchema,
    terminal: terminalSessionSchema.nullable(),
    url: z.string().nullable(),
    logs: z.string().max(32_768),
    error: z.string().nullable(),
    detachedAt: z.number().int(),
    processExit: z.literal("unconfirmed"),
  })
  .strict();

export const projectPreviewSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  config: previewLaunchConfigSchema.nullable(),
  terminal: terminalSessionSchema.nullable(),
  status: z.enum([
    "unconfigured",
    "stopped",
    "starting",
    "running",
    "disconnected",
    "failed",
    "detached",
  ]),
  cleanup: z
    .object({ terminalId: z.string().min(1), hostId: z.string().min(1) })
    .strict()
    .nullable(),
  detachedSessions: z.array(detachedPreviewSessionSchema).max(20),
  url: z.string().nullable(),
  logs: z.string(),
  error: z.string().nullable(),
});
export type ProjectPreview = z.infer<typeof projectPreviewSchema>;
