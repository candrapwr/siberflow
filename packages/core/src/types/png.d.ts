declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(opts?: { width?: number; height?: number });
    static sync: {
      read(buffer: Buffer, opts?: unknown): PNG;
      write(png: PNG, opts?: unknown): Buffer;
    };
  }
}

declare module "jpeg-js" {
  export interface RawImageData {
    width: number;
    height: number;
    data: Buffer | Uint8Array;
  }
  export function encode(
    img: RawImageData,
    quality?: number,
    options?: unknown,
  ): { data: Buffer; width: number; height: number };
  export function decode(
    buf: Buffer | Uint8Array,
    options?: { useTint?: boolean; toRGBA?: boolean },
  ): RawImageData;
}
