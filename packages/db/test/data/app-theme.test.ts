import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getStoredFaviconColor,
  getStoredSurfaceStyle,
  getStoredThemeId,
  setStoredAppearance,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

describe("appearance surface storage", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
  });

  afterEach(() => {
    db.$client.close();
  });

  it("migrates an existing palette and favicon with the default surface", () => {
    db.$client.exec("ALTER TABLE app_theme DROP COLUMN surface_style");
    db.$client.exec(
      "INSERT INTO app_theme (id, theme_id, favicon_color, updated_at) VALUES ('current', 'nord', 'teal', 1)",
    );
    db.$client.exec(
      readFileSync(
        new URL("../../drizzle/0116_arc_liquid_glass.sql", import.meta.url),
        "utf8",
      ),
    );

    expect(getStoredThemeId(db)).toBe("nord");
    expect(getStoredFaviconColor(db)).toBe("teal");
    expect(getStoredSurfaceStyle(db)).toBe("default");
    setStoredAppearance(db, {
      themeId: "nord",
      faviconColor: "teal",
      surfaceStyle: "liquid-glass",
    });
    expect(getStoredSurfaceStyle(db)).toBe("liquid-glass");
  });

  it("falls back safely for an absent or invalid stored surface", () => {
    expect(getStoredSurfaceStyle(db)).toBe("default");
    setStoredAppearance(db, {
      themeId: "dracula",
      faviconColor: "pink",
      surfaceStyle: "liquid-glass",
    });
    db.$client.exec(
      "UPDATE app_theme SET surface_style = 'unknown' WHERE id = 'current'",
    );
    expect(getStoredSurfaceStyle(db)).toBe("default");
    expect(getStoredThemeId(db)).toBe("dracula");
    expect(getStoredFaviconColor(db)).toBe("pink");
  });
});
