import { z } from "zod";

export const hostLaneSchema = z
  .object({
    key: z.string().min(1).max(200),
    fence: z.number().int().positive(),
  })
  .strict();

const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export const hostProcessReceiptSchema = z
  .object({
    executable: z.string(),
    args: z.array(z.string()),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    stdoutDigest: digest,
    stderrDigest: digest,
    truncated: z.boolean(),
    interrupted: z.boolean(),
    startedAt: z.string(),
    finishedAt: z.string(),
  })
  .strict();
