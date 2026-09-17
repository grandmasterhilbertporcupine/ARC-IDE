import { eq } from "drizzle-orm";
import {
  appSurfaceStyleSchema,
  defaultAppSurfaceStyle,
  defaultAppTheme,
  defaultFaviconColor,
  type FaviconColorPreference,
  type AppSurfaceStyle,
  type AppTheme,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { appTheme } from "../schema.js";

const APP_THEME_ROW_ID = "current";

export function getStoredThemeId(db: DbConnection): string {
  const row = db
    .select({ themeId: appTheme.themeId })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.themeId ?? defaultAppTheme.themeId;
}

export function getStoredFaviconColor(
  db: DbConnection,
): FaviconColorPreference {
  const row = db
    .select({ faviconColor: appTheme.faviconColor })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.faviconColor ?? defaultFaviconColor;
}

export function getStoredSurfaceStyle(db: DbConnection): AppSurfaceStyle {
  const row = db
    .select({ surfaceStyle: appTheme.surfaceStyle })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();
  const parsed = appSurfaceStyleSchema.safeParse(row?.surfaceStyle);
  return parsed.success ? parsed.data : defaultAppSurfaceStyle;
}

export function setStoredAppearance(
  db: DbConnection,
  appearance: Pick<AppTheme, "themeId" | "faviconColor" | "surfaceStyle">,
): void {
  const updatedAt = Date.now();
  const { themeId, faviconColor, surfaceStyle } = appearance;
  db.insert(appTheme)
    .values({
      id: APP_THEME_ROW_ID,
      themeId,
      faviconColor,
      surfaceStyle,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: appTheme.id,
      set: { themeId, faviconColor, surfaceStyle, updatedAt },
    })
    .run();
}
