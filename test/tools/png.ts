import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough PNG to crop the thumbnails macOS renders and to let tests read
 * pixels back: 8-bit RGB or RGBA, not interlaced.
 */

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Four bytes per pixel, row by row. */
  readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const decodePng = (png: Uint8Array): RgbaImage => {
  const buffer = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = body.subarray(8);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[out + x - channels]! : 0;
      const up = y > 0 ? rows[out - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? rows[out - stride + x - channels]! : 0;
      const value = line[x]!;
      rows[out + x] = (filter === 0 ? value
        : filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + ((left + up) >> 1)
              : value + paeth(left, up, upLeft)) & 0xff;
    }
  }

  if (channels === 4) {
    return { width, height, data: rows };
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i]!;
    data[j + 1] = rows[i + 1]!;
    data[j + 2] = rows[i + 2]!;
    data[j + 3] = 255;
  }
  return { width, height, data };
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export const encodePng = ({ width, height, data }: RgbaImage): Buffer => {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

export const cropImage = (image: RgbaImage, width: number, height: number): RgbaImage => {
  const w = Math.min(width, image.width);
  const h = Math.min(height, image.height);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.set(image.data.subarray(y * image.width * 4, (y * image.width + w) * 4), y * w * 4);
  }
  return { width: w, height: h, data };
};

/** The pixel at (x, y) as `#rrggbb`. */
export const pixelAt = (image: RgbaImage, x: number, y: number): string => {
  const i = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return `#${[...image.data.subarray(i, i + 3)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const chunk = (type: string, body: Buffer): Buffer => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};
