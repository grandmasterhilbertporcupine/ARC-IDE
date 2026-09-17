import { describe, expect, it } from "vitest";
import {
  listenerBelongsToTerminal,
  probeTerminalPreview,
} from "./preview-probe.js";
describe("owned preview readiness", () => {
  it("requires the listener itself or a descendant of the exact terminal process", () => {
    const processes = [
      { pid: 10, parent: 1 },
      { pid: 20, parent: 10 },
      { pid: 30, parent: 20 },
      { pid: 40, parent: 1 },
    ];
    expect(listenerBelongsToTerminal(30, 10, processes)).toBe(true);
    expect(listenerBelongsToTerminal(10, 10, processes)).toBe(true);
    expect(listenerBelongsToTerminal(40, 10, processes)).toBe(false);
    expect(listenerBelongsToTerminal(1, 10, processes)).toBe(false);
    expect(
      listenerBelongsToTerminal(70, 10, [
        { pid: 70, parent: 80 },
        { pid: 80, parent: 70 },
      ]),
    ).toBe(false);
  });
  it("refuses arbitrary network or credential-bearing URLs before inspection", async () => {
    for (const url of [
      "https://example.com/",
      "http://user:secret@localhost/",
      "file:///etc/passwd",
    ])
      expect(await probeTerminalPreview(123, url)).toMatchObject({
        state: "unavailable",
        statusCode: null,
      });
  });
});
