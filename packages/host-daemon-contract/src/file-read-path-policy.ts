import { z } from "zod";

export const hostReadFilePathPolicySchema = z
  .object({
    denyDotfiles: z.boolean(),
    deniedExtensions: z
      .array(
        z
          .string()
          .regex(/^\.[a-zA-Z0-9]+$/u)
          .max(32),
      )
      .max(64),
  })
  .strict();

export type HostReadFilePathPolicy = z.infer<
  typeof hostReadFilePathPolicySchema
>;

export function isAllowedHostReadRelativePath(
  relativePath: string,
  policy: HostReadFilePathPolicy,
): boolean {
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        /[\x00-\x1f\x7f:]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        /%[0-9a-f]{2}/iu.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment) ||
        (policy.denyDotfiles && segment.startsWith(".")),
    )
  )
    return false;
  const filename = segments.at(-1)!.toLowerCase();
  return !policy.deniedExtensions.some((extension) =>
    filename.endsWith(extension.toLowerCase()),
  );
}
