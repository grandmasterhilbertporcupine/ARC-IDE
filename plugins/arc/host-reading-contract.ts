import { z } from "zod";

export const boundedReadInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !value.includes("\0") &&
          !/^(?:[a-z]:|[\\/])/i.test(value) &&
          !value.split(/[\\/]/).includes(".."),
        "Choose a relative file inside the assigned workspace",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(2 ** 40)
      .default(0),
    maxBytes: z.number().int().min(64).max(8192).default(8192),
  })
  .strict();
export const boundedReadingHostMethods = {
  readBoundedWorkspaceFile: {
    input: boundedReadInputSchema.extend({
      root: z.string().min(1).max(32768),
    }),
    output: z
      .object({
        path: z.string(),
        offset: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative().nullable(),
        size: z.number().int().nonnegative(),
        text: z.string().max(8196),
        truncated: z.boolean(),
      })
      .strict(),
  },
};
