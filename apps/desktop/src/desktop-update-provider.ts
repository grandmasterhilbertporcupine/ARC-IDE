import {
  createBbDesktopVersionFeedFileName,
  type BbDesktopVersionFeedPlatform,
} from "@bb/desktop-contract";
import {
  createDesktopReleaseConfig,
  createDesktopUpdateConfig,
  type DesktopReleaseChannel,
} from "../scripts/desktop-release-channel.mjs";

export type { DesktopAutoUpdateFeedConfig } from "../scripts/desktop-release-channel.mjs";

interface DesktopReleaseInfo {
  applicationName: "ARC" | "ARC Nightly";
  channel: DesktopReleaseChannel;
  iconFileName: "arc-icon.png";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateReleaseBaseUrl: string;
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseInfo {
  const release = createDesktopReleaseConfig(channel);
  const update = createDesktopUpdateConfig(
    channel,
    process.env.ARC_UPDATE_BASE_URL,
  );

  return {
    applicationName: release.applicationName,
    channel,
    iconFileName: release.iconFileName,
    releaseTag: release.releaseTag,
    updateReleaseBaseUrl: update.updateReleaseBaseUrl,
  };
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest or nightly, got ${String(rawChannel)}.`,
  );
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.BB_DESKTOP_RELEASE_CHANNEL,
);
export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);
const DESKTOP_UPDATE_CONFIG = createDesktopUpdateConfig(
  DESKTOP_RELEASE_CHANNEL,
  process.env.ARC_UPDATE_BASE_URL,
);

export function createDesktopUpdateFeedUrl(
  platform: BbDesktopVersionFeedPlatform,
): string {
  if (!DESKTOP_UPDATE_CONFIG.platforms.includes(platform)) return "";
  return `${DESKTOP_UPDATE_CONFIG.updateReleaseBaseUrl}${createBbDesktopVersionFeedFileName(platform)}`;
}

export const DESKTOP_AUTO_UPDATE_FEED_CONFIG = DESKTOP_UPDATE_CONFIG.feedConfig;

interface DesktopUpdateSupport {
  autoUpdate: boolean;
  versionCheck: boolean;
}

interface ResolveDesktopUpdateSupportArgs {
  canReplaceAppImage: (appImagePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  platform: BbDesktopVersionFeedPlatform;
}

export function resolveDesktopUpdateSupport(
  args: ResolveDesktopUpdateSupportArgs,
): DesktopUpdateSupport {
  if (!DESKTOP_UPDATE_CONFIG.platforms.includes(args.platform))
    return { autoUpdate: false, versionCheck: false };
  if (args.platform === "macos" || args.platform === "windows") {
    return { autoUpdate: true, versionCheck: true };
  }

  const appImagePath = args.env.APPIMAGE?.trim() ?? "";
  if (appImagePath.length === 0) {
    return { autoUpdate: false, versionCheck: true };
  }

  return {
    autoUpdate: args.canReplaceAppImage(appImagePath),
    versionCheck: true,
  };
}
