# ARC changelog

## 0.42.9

The first GitHub-enabled Windows release.

- Download ARC directly from its GitHub Releases page.
- Check for stable updates in Settings, download them in the background, and install on restart or quit.
- Show failed update checks with a retry action and keep ARC's download cache separate.
- Fix plugin catalog generation during a fresh source installation.
- Keep installer shortcut preferences and existing ARC data when updating.
- Include the custom title bar, Liquid Glass appearance, centered new-thread composer, Astra model option, panel animations, and Windows reliability fixes from 0.42.8.

This personal build is unsigned. Earlier local builds with updates disabled need a one-time manual install.

## 0.42.8

ARC branding throughout the desktop workspace, built-in tools, and setup.

### Improvements

- Use consistent ARC names in settings, plugin collections, workflow messages, and help.
- Show ARC release notes directly in the app, including when offline.
- Keep existing integrations, saved settings, and command compatibility.
- Fix Windows npm launching when creating a plugin and recognize local Windows Git repository paths.
- Keep task attachment paths correct when working with Windows and Linux machines.
- Keep new-thread drafts visible after reloading an empty workspace.

## 0.42.7

Choose how to open ARC after installation.

### Windows setup

- Choose whether to create a desktop shortcut and add ARC to the Start menu.
- Remember shortcut choices when reinstalling.
- Launch ARC from the Finish screen, even with both shortcut options off.

## 0.42.6

Clearer navigation when panels are collapsed.

### Fixes

- Keep the sidebar toggle clear of the Threads heading and project subtitle.
- Coordinate panel spacing with opening and closing animations.

## 0.42.5

An ARC-themed Windows setup experience.

### Windows setup

- Add an animated ARC mark and a consistent dark setup surface.
- Respect Windows animation and high-contrast preferences.

## 0.42.4

ARC on the Windows desktop.

### Desktop

- Integrate a custom title bar with native Windows caption controls.
- Follow the selected appearance, including Liquid Glass.
- Package ARC with its local runtime, built-in tools, and Context assets.
