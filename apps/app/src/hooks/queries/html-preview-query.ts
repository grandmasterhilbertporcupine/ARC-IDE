import { useQuery } from "@tanstack/react-query";
import { isHtmlFilePreviewPath } from "@bb/client-core";
import { sdk } from "@/lib/sdk";

export function useHtmlPreviewUrl({
  hostId,
  rootPath,
  filePath,
  enabled,
}: {
  hostId: string | null | undefined;
  rootPath: string | null | undefined;
  filePath: string;
  enabled: boolean;
}) {
  const available =
    enabled && Boolean(hostId && rootPath) && isHtmlFilePreviewPath(filePath);
  return useQuery({
    queryKey: ["html-preview-lease", hostId, rootPath, filePath],
    enabled: available,
    staleTime: 4 * 60_000,
    refetchInterval: available ? 4 * 60_000 : false,
    queryFn: async ({ signal }) => {
      if (!hostId || !rootPath)
        throw new Error("HTML preview host and directory are required");
      const lease = await sdk.files.createPreview({ hostId, rootPath, signal });
      return `${lease.baseUrl}/${filePath.replace(/\\/gu, "/").split("/").map(encodeURIComponent).join("/")}`;
    },
  });
}

export function hostHtmlPreviewTarget(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const root = path.slice(0, index);
  return {
    rootPath:
      index === 0 ? "/" : /^[A-Za-z]:$/u.test(root) ? `${root}\\` : root,
    filePath: path.slice(index + 1),
  };
}
