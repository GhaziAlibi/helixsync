// `deflate-raw` through CompressionStream, feature-detected rather than
// version-gated: support in a service worker at the minimum Chrome version
// (116) is unverified. Callers omit their `codec` marker when it is missing
// and store the bytes uncompressed.
let deflateSupported: boolean | null = null;

export function supportsDeflateRaw(): boolean {
  if (deflateSupported === null) {
    deflateSupported = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
  }
  return deflateSupported;
}

export function resetDeflateSupportForTesting(): void {
  deflateSupported = null;
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
