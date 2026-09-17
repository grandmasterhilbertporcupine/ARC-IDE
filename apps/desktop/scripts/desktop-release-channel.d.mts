export type DesktopReleaseChannel = "latest" | "nightly";
export type DesktopBuildPlatform = "macos" | "linux" | "windows";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml";
  windows: "latest.yml" | "nightly.yml";
}

export interface DesktopReleaseConfig {
  appId: "dev.arc.desktop" | "dev.arc.desktop.nightly";
  applicationName: "ARC" | "ARC Nightly";
  artifactName: string;
  iconFileName: "arc-icon.png";
  linuxExecutableName: "arc" | "arc-nightly";
  windowsExecutableName: "ARC IDE" | "ARC IDE Nightly";
  macIconPath: "assets/arc-icon.icns";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateMetadataFileNames: DesktopUpdateMetadataFileNames;
}

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
): DesktopReleaseChannel;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
): DesktopReleaseConfig;

export type DesktopAutoUpdateFeedConfig =
  | {
      channel: DesktopReleaseChannel;
      provider: "generic";
      url: string;
    }
  | {
      channel: DesktopReleaseChannel;
      provider: "github";
      owner: "grandmasterhilbertporcupine";
      repo: "ARC-IDE";
    };

export interface DesktopUpdateConfig {
  feedConfig: DesktopAutoUpdateFeedConfig;
  updateReleaseBaseUrl: string;
  platforms: DesktopBuildPlatform[];
}

export function createDesktopUpdateConfig(
  channel: DesktopReleaseChannel,
  updateBaseUrl: string | undefined,
): DesktopUpdateConfig;
