const MAX_DIMENSION = 8192;
const MAX_PIXELS = 20_000_000;

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("Photo preparation stopped.", "AbortError");
}

async function encodePng(canvas, signal) {
  checkAbort(signal);
  const blob = await new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Photo preparation stopped.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    canvas.toBlob(value => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) { abort(); return; }
      if (value) resolve(value);
      else reject(new Error("This photo could not be prepared for local reading."));
    }, "image/png");
  });
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => { reader.abort(); cleanup(); reject(new DOMException("Photo preparation stopped.", "AbortError")); };
    reader.onload = () => { cleanup(); if (signal?.aborted) abort(); else resolve(String(reader.result)); };
    reader.onerror = () => { cleanup(); reject(new Error("This photo could not be prepared for local reading.")); };
    reader.onabort = () => { cleanup(); reject(new DOMException("Photo preparation stopped.", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

/**
 * Prepare a PNG for the existing local reader. Never sends a request or changes
 * the source file. Resizing requires a separate, explicit caller choice.
 */
export async function prepareReceiptPhoto(file, {
  rotation = 0, signal, encodedLimit = 6 * 1024 * 1024, allowResize = false,
} = {}) {
  if (!Number.isSafeInteger(encodedLimit) || encodedLimit < 1) throw new Error("The local reader image limit is invalid.");
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new Error("Rotate the receipt in quarter turns.");
  rotation = ((rotation % 360) + 360) % 360;
  checkAbort(signal);
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    checkAbort(signal);
    const original = { width: bitmap.width, height: bitmap.height };
    const sideways = rotation % 180 !== 0;
    const nativeWidth = sideways ? bitmap.height : bitmap.width;
    const nativeHeight = sideways ? bitmap.width : bitmap.height;
    const nativeFits = nativeWidth <= MAX_DIMENSION && nativeHeight <= MAX_DIMENSION && nativeWidth * nativeHeight <= MAX_PIXELS;
    if (!nativeFits && !allowResize) {
      return { kind: "needs-resize", original, prepared: { width: nativeWidth, height: nativeHeight, encodedBytes: null }, rotation, limit: encodedLimit };
    }
    let scale = nativeFits ? 1 : Math.min(MAX_DIMENSION / nativeWidth, MAX_DIMENSION / nativeHeight, Math.sqrt(MAX_PIXELS / (nativeWidth * nativeHeight)));
    for (let attempt = 0; attempt < 8; attempt++) {
      checkAbort(signal);
      const width = Math.max(1, Math.floor(nativeWidth * scale));
      const height = Math.max(1, Math.floor(nativeHeight * scale));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot prepare a receipt photo.");
      context.translate(width / 2, height / 2);
      context.rotate(rotation * Math.PI / 180);
      context.drawImage(bitmap, -(sideways ? height : width) / 2, -(sideways ? width : height) / 2, sideways ? height : width, sideways ? width : height);
      const image = await encodePng(canvas, signal);
      checkAbort(signal);
      const prepared = { width, height, encodedBytes: image.length };
      if (image.length <= encodedLimit) {
        return { kind: "ready", image, original, prepared, rotation, resized: width !== nativeWidth || height !== nativeHeight };
      }
      if (!allowResize) return { kind: "needs-resize", original, prepared, rotation, limit: encodedLimit };
      if (width === 1 && height === 1) break;
      scale *= Math.min(0.9, Math.sqrt(encodedLimit / image.length) * 0.95);
    }
    throw new Error("A smaller copy could not fit the local reader. Use the browser reader or enter items yourself.");
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
