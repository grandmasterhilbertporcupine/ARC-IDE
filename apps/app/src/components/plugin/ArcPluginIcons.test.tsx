// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { pluginPackageJsonSchema } from "@bb/domain";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { PluginIcon } from "./PluginIcon";

const runtimeDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "__bbPluginRuntime",
);
const pluginRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../plugins/arc",
);
const manifest = pluginPackageJsonSchema.parse(
  JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8")),
);
const registrations = await loadPluginApp(
  () => import("../../../../../plugins/arc/app"),
);

beforeEach(() => {
  setPluginLogoUrls(
    new Map([
      [
        "arc",
        {
          displayName: manifest.bb.name,
          icon: manifest.bb.branding.icon ?? null,
          compactIconUrl: null,
          logoUrl: manifest.bb.branding.logo?.light ?? null,
          logoDarkUrl: manifest.bb.branding.logo?.dark ?? null,
          icons: new Map(),
        },
      ],
    ]),
  );
});

afterEach(() => {
  cleanup();
  resetPluginLogoStoreForTest();
});

afterAll(() => {
  if (runtimeDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "__bbPluginRuntime");
  } else {
    Object.defineProperty(globalThis, "__bbPluginRuntime", runtimeDescriptor);
  }
});

it("renders distinct destination glyphs with ARC's installed branding", () => {
  const view = render(
    <>
      {registrations.navPanels.map((panel) => (
        <div key={panel.id} data-testid={panel.id}>
          <PluginIcon pluginId="arc" icon={panel.icon ?? null} />
          {panel.title}
        </div>
      ))}
    </>,
  );

  for (const [id, name] of Object.entries({
    workspace: "Workflow",
    runs: "ListView",
    teams: "Layers",
    context: "Explore",
    orchestration: "SlidersHorizontal",
    agents: "Bot",
  })) {
    const icon = view.getByTestId(id).querySelector(`svg[data-icon="${name}"]`);
    expect(icon).toBeTruthy();
    expect(icon?.children.length).toBeGreaterThan(0);
  }
  expect(view.container.querySelector("[data-icon-pending]")).toBeNull();
  expect(view.container.querySelector("[data-icon=Zap]")).toBeNull();
});

it("keeps Assistant and Test agent tabs visually distinct", () => {
  const agents = registrations.navPanels.find((panel) => panel.id === "agents");
  expect(agents).toBeDefined();
  const view = render(
    <>
      {agents?.fixedTabs?.map((tab) => (
        <div key={tab.id} data-testid={tab.title}>
          <PluginIcon pluginId="arc" icon={tab.icon ?? null} />
        </div>
      ))}
    </>,
  );

  expect(
    view.getByTestId("Assistant").querySelector("svg[data-icon=MessageSquare]"),
  ).toBeTruthy();
  expect(
    view.getByTestId("Test agent").querySelector("svg[data-icon=Play]"),
  ).toBeTruthy();
  expect(view.container.querySelector("[data-icon-pending]")).toBeNull();
});

it("retains the existing ARC artwork for logo surfaces", async () => {
  const logo = manifest.bb.branding.logo?.light;
  if (logo === undefined) throw new Error("ARC branding must retain its logo");
  const asset = await readFile(resolve(pluginRoot, logo));
  const source = await readFile(
    resolve(pluginRoot, "../../ARC Graphics/ARC-ICON.png"),
  );
  expect(asset.equals(source)).toBe(true);
});
