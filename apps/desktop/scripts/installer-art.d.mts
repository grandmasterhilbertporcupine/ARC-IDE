export function bitmapFrame(rgb: Buffer, width: number, height: number): Buffer;
export function bitmapFile(rgb: Buffer, width: number, height: number): Buffer;
export function animationFile(
  frames: Buffer[],
  width: number,
  height: number,
  fps: number,
): Buffer;
