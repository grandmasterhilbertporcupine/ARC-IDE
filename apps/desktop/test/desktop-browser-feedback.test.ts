import { describe, expect, it } from "vitest";
import {
  previewDiagnosticUrl,
  redactPreviewDiagnostic,
} from "../src/desktop-browser-feedback.js";
import { bbDesktopBrowserFeedbackSchema } from "@bb/desktop-contract";

describe("preview feedback boundaries", () => {
  it("excludes credentials, query values and fragments from network records", () => {
    expect(
      previewDiagnosticUrl(
        "https://user:secret@example.test/api?token=private#auth",
      ),
    ).toBe("https://example.test/api");
    expect(previewDiagnosticUrl("invalid")).toBe("[unavailable URL]");
  });
  it("redacts common diagnostic secrets and bounds noisy console messages", () => {
    expect(
      redactPreviewDiagnostic(
        "Authorization: Bearer abcdef password=private token=hidden",
      ),
    ).not.toMatch(/abcdef|private|hidden/u);
    expect(redactPreviewDiagnostic("x".repeat(5000))).toHaveLength(1000);
  });
  it("rejects overlarge or malformed feedback crossing the desktop bridge", () => {
    const feedback = {
      url: "http://localhost/",
      title: "Preview",
      screenshot: "jpeg",
      element: null,
      console: [],
      network: [],
    };
    expect(bbDesktopBrowserFeedbackSchema.safeParse(feedback).success).toBe(
      true,
    );
    expect(
      bbDesktopBrowserFeedbackSchema.safeParse({
        ...feedback,
        console: Array.from({ length: 51 }, () => ({
          level: "error",
          message: "failure",
        })),
      }).success,
    ).toBe(false);
    expect(
      bbDesktopBrowserFeedbackSchema.safeParse({
        ...feedback,
        element: { selector: "button" },
      }).success,
    ).toBe(false);
  });
});
