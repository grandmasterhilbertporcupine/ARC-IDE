const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest or nightly, got ${rawChannel}.`,
  );
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }
  if (nodePlatform === "win32") {
    return "windows";
  }

  throw new Error(
    `Desktop builds support darwin, linux and win32, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.arc.desktop.nightly",
      applicationName: "ARC Nightly",
      artifactName: "ARC-nightly-${version}-${arch}.${ext}",
      iconFileName: "arc-icon.png",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "arc-nightly",
      windowsExecutableName: "ARC IDE Nightly",
      macIconPath: "assets/arc-icon.icns",
      releaseTag: "desktop-nightly",
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
        windows: "nightly.yml",
      },
    };
  }

  return {
    appId: "dev.arc.desktop",
    applicationName: "ARC",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "arc-icon.png",
    linuxExecutableName: "arc",
    windowsExecutableName: "ARC IDE",
    macIconPath: "assets/arc-icon.icns",
    releaseTag: "desktop-latest",
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
      windows: "latest.yml",
    },
  };
}

export function createDesktopUpdateConfig(channel, updateBaseUrl) {
  const base = updateBaseUrl?.trim();
  if (base === undefined && channel === "latest") {
    return {
      feedConfig: {
        channel,
        provider: "github",
        owner: "grandmasterhilbertporcupine",
        repo: "ARC-IDE",
      },
      updateReleaseBaseUrl:
        "https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases/latest/download/",
      platforms: ["windows"],
    };
  }

  let updateReleaseBaseUrl = "";
  if (base) {
    const url = new URL(base);
    if (url.protocol !== "https:")
      throw new Error("ARC_UPDATE_BASE_URL must use HTTPS.");
    const { releaseTag } = createDesktopReleaseConfig(channel);
    updateReleaseBaseUrl = `${url.href.replace(/\/$/, "")}/${releaseTag}/`;
  }

  return {
    feedConfig: { channel, provider: "generic", url: updateReleaseBaseUrl },
    updateReleaseBaseUrl,
    platforms: updateReleaseBaseUrl ? ["windows", "macos", "linux"] : [],
  };
}
