export function bitmapFrame(rgb, width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 1024 ||
    height > 1024 ||
    rgb.length !== width * height * 3
  )
    throw new Error("Invalid installer artwork dimensions");
  const stride = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const input = (y * width + x) * 3;
      const output = (height - 1 - y) * stride + x * 3;
      pixels[output] = rgb[input + 2];
      pixels[output + 1] = rgb[input + 1];
      pixels[output + 2] = rgb[input];
    }
  }
  return pixels;
}

function bitmapInfo(width, height) {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(width, 4);
  info.writeInt32LE(height, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  info.writeUInt32LE(Math.ceil((width * 3) / 4) * 4 * height, 20);
  return info;
}

export function bitmapFile(rgb, width, height) {
  const pixels = bitmapFrame(rgb, width, height);
  const header = Buffer.alloc(14);
  header.write("BM");
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  return Buffer.concat([header, bitmapInfo(width, height), pixels]);
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

export function animationFile(frames, width, height, fps) {
  if (
    !Number.isInteger(fps) ||
    fps < 1 ||
    fps > 30 ||
    frames.length < 2 ||
    frames.length > 240
  )
    throw new Error("Invalid installer animation duration");
  const pixels = frames.map((frame) => bitmapFrame(frame, width, height));
  const header = Buffer.alloc(56);
  header.writeUInt32LE(Math.round(1_000_000 / fps), 0);
  header.writeUInt32LE(pixels[0].length * fps, 4);
  header.writeUInt32LE(0x10, 12);
  header.writeUInt32LE(frames.length, 16);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(pixels[0].length, 28);
  header.writeUInt32LE(width, 32);
  header.writeUInt32LE(height, 36);
  const stream = Buffer.alloc(56);
  stream.write("vidsDIB ", 0, 8, "ascii");
  stream.writeUInt32LE(1, 20);
  stream.writeUInt32LE(fps, 24);
  stream.writeUInt32LE(frames.length, 32);
  stream.writeUInt32LE(pixels[0].length, 36);
  stream.writeUInt32LE(0xffffffff, 40);
  stream.writeInt16LE(width, 52);
  stream.writeInt16LE(height, 54);
  const streams = chunk(
    "LIST",
    Buffer.concat([
      Buffer.from("strl"),
      chunk("strh", stream),
      chunk("strf", bitmapInfo(width, height)),
    ]),
  );
  const headers = chunk(
    "LIST",
    Buffer.concat([Buffer.from("hdrl"), chunk("avih", header), streams]),
  );
  let offset = 4;
  const index = Buffer.alloc(frames.length * 16);
  const movie = pixels.map((frame, i) => {
    index.write("00db", i * 16, 4, "ascii");
    index.writeUInt32LE(0x10, i * 16 + 4);
    index.writeUInt32LE(offset, i * 16 + 8);
    index.writeUInt32LE(frame.length, i * 16 + 12);
    const data = chunk("00db", frame);
    offset += data.length;
    return data;
  });
  return chunk(
    "RIFF",
    Buffer.concat([
      Buffer.from("AVI "),
      headers,
      chunk("LIST", Buffer.concat([Buffer.from("movi"), ...movie])),
      chunk("idx1", index),
    ]),
  );
}
