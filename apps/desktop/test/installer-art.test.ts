import { describe, expect, it } from "vitest";
import {
  animationFile,
  bitmapFile,
  bitmapFrame,
} from "../scripts/installer-art.mjs";

describe("native installer animation assets", () => {
  it("writes bottom-up BGR rows with four-byte alignment for Windows bitmaps", () => {
    const rgb = Buffer.from([255, 0, 0, 0, 255, 0]);
    expect([...bitmapFrame(rgb, 1, 2)]).toEqual([0, 255, 0, 0, 0, 0, 255, 0]);
    const bmp = bitmapFile(rgb, 1, 2);
    expect(bmp.toString("ascii", 0, 2)).toBe("BM");
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    expect(bmp.readUInt32LE(10)).toBe(54);
    expect(bmp.readUInt16LE(28)).toBe(24);
    expect(bmp.readUInt32LE(30)).toBe(0);
  });

  it("emits indexed, silent uncompressed AVI frames accepted by SysAnimate32", () => {
    const frames = [Buffer.from([255, 0, 0]), Buffer.from([0, 255, 0])];
    const avi = animationFile(frames, 1, 1, 20);
    expect(avi.toString("ascii", 0, 4)).toBe("RIFF");
    expect(avi.readUInt32LE(4)).toBe(avi.length - 8);
    expect(avi.toString("ascii", 8, 12)).toBe("AVI ");
    const header = avi.indexOf("avih") + 8;
    expect(avi.readUInt32LE(header)).toBe(50_000);
    expect(avi.readUInt32LE(header + 16)).toBe(2);
    expect(avi.readUInt32LE(header + 24)).toBe(1);
    expect(avi.includes(Buffer.from("auds"))).toBe(false);
    expect(avi.includes(Buffer.from("vidsDIB "))).toBe(true);
    const movie = avi.indexOf("movi");
    const index = avi.indexOf("idx1") + 8;
    for (let i = 0; i < frames.length; i++) {
      const position = movie + avi.readUInt32LE(index + i * 16 + 8);
      const length = avi.readUInt32LE(index + i * 16 + 12);
      expect(avi.toString("ascii", position, position + 4)).toBe("00db");
      expect(avi.subarray(position + 8, position + 8 + length)).toEqual(
        bitmapFrame(frames[i], 1, 1),
      );
    }
  });

  it("rejects malformed frame dimensions and unsafe animation lengths before output", () => {
    expect(() => bitmapFrame(Buffer.alloc(4), 1, 1)).toThrow("dimensions");
    expect(() => bitmapFrame(Buffer.alloc(3), -1, 1)).toThrow("dimensions");
    expect(() => animationFile([Buffer.alloc(3)], 1, 1, 20)).toThrow(
      "duration",
    );
    expect(() =>
      animationFile([Buffer.alloc(3), Buffer.alloc(3)], 1, 1, 60),
    ).toThrow("duration");
  });
});
