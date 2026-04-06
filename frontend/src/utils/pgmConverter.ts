/**
 * @file pgmConverter.ts
 * @description Parses PGM (Portable Graymap) image files and converts them to
 *   a PNG Blob that can be displayed in a browser <img> element or uploaded to
 *   cloud storage.
 *
 * Supported PGM sub-formats:
 *   - P2  ASCII graymap  (plain text pixel values)
 *   - P5  Binary graymap (raw byte or two-byte pixel values) — standard ROS output
 *
 * PGM file structure (both formats share the same ASCII header):
 *   Line 1 : Magic number  ("P2" or "P5")
 *   Lines  : Zero or more comment lines starting with '#'
 *   Tokens : width  height  (decimal integers separated by whitespace)
 *   Token  : maxval         (max grayscale value; 255 for 8-bit, up to 65535 for 16-bit)
 *   Data   : P2 — space-separated decimal values
 *             P5 — 1 byte per pixel (maxval <= 255) or 2 bytes big-endian (maxval > 255)
 *   Important: for P5, exactly ONE whitespace byte separates the last header token
 *              from the start of binary data.
 */

// ============================================================
// PUBLIC TYPES
// ============================================================

/**
 * Result returned by `convertPgmToPng`.
 */
export interface PgmConvertResult {
  /** PNG Blob ready to be uploaded or used as an object URL. */
  blob: Blob;
  /** Original image width in pixels (from the PGM header). */
  width: number;
  /** Original image height in pixels (from the PGM header). */
  height: number;
}

// ============================================================
// INTERNAL PARSER HELPERS
// ============================================================

/**
 * State object threaded through the header parser so the position cursor
 * can be mutated without using closure variables.
 */
interface ParseState {
  data: Uint8Array;
  pos: number;
}

/** ASCII code constants for readability. */
const CHAR_HASH      = 35; // '#'
const CHAR_NEWLINE   = 10; // '\n'
const CHAR_SPACE     = 32; // ' '
const CHAR_TAB       = 9;  // '\t'
const CHAR_CARRIAGE  = 13; // '\r'

/**
 * Determines whether a byte is a whitespace character per the PGM spec.
 * @param byte - Raw byte value.
 */
function isWhitespace(byte: number): boolean {
  return (
    byte === CHAR_SPACE    ||
    byte === CHAR_TAB      ||
    byte === CHAR_NEWLINE  ||
    byte === CHAR_CARRIAGE
  );
}

/**
 * Advances `state.pos` past all whitespace characters and PGM comment lines
 * (lines beginning with '#').
 * @param state - Mutable parse state.
 */
function skipWhitespaceAndComments(state: ParseState): void {
  const { data } = state;

  while (state.pos < data.length) {
    // Skip consecutive whitespace bytes.
    while (state.pos < data.length && isWhitespace(data[state.pos])) {
      state.pos++;
    }

    // If the current byte starts a comment, skip the entire line.
    if (data[state.pos] === CHAR_HASH) {
      while (state.pos < data.length && data[state.pos] !== CHAR_NEWLINE) {
        state.pos++;
      }
      // The outer loop will then skip the '\n' on the next iteration.
      continue;
    }

    // Not whitespace and not a comment — we are at the start of a token.
    break;
  }
}

/**
 * Reads the next non-whitespace token from the header as a string.
 * Skips preceding whitespace and comment lines before reading.
 * @param state - Mutable parse state (position is advanced past the token).
 * @returns The token string (e.g., "P5", "640", "255").
 */
function readToken(state: ParseState): string {
  skipWhitespaceAndComments(state);

  let token = '';
  while (state.pos < state.data.length && !isWhitespace(state.data[state.pos])) {
    token += String.fromCharCode(state.data[state.pos]);
    state.pos++;
  }
  return token;
}

// ============================================================
// MAIN CONVERTER
// ============================================================

/**
 * Converts a PGM file (P2 or P5 format) to a PNG Blob suitable for browser
 * display or cloud storage upload.
 *
 * Processing steps:
 *   1. Read the file into a Uint8Array.
 *   2. Parse the ASCII header to extract format, dimensions, and bit depth.
 *   3. Decode grayscale pixel values (normalizing to 0–255 if maxval > 255).
 *   4. Write RGBA pixels onto an off-screen <canvas>.
 *   5. Export the canvas as a PNG Blob.
 *
 * @param file - The .pgm File object selected by the user.
 * @returns A Promise resolving to `PgmConvertResult` containing the PNG Blob,
 *          the source image width, and the source image height.
 * @throws {Error} If the file is not a recognised P2/P5 PGM or the header is malformed.
 *
 * @example
 * const { blob, width, height } = await convertPgmToPng(pgmFile);
 * const url = URL.createObjectURL(blob);
 */
export async function convertPgmToPng(file: File): Promise<PgmConvertResult> {
  const buffer = await file.arrayBuffer();
  const state: ParseState = { data: new Uint8Array(buffer), pos: 0 };

  // --- Parse header ---
  const magic = readToken(state);
  if (magic !== 'P5' && magic !== 'P2') {
    throw new Error(
      `Unsupported PGM format: "${magic}". Expected P5 (binary) or P2 (ASCII).`
    );
  }

  const width  = parseInt(readToken(state), 10);
  const height = parseInt(readToken(state), 10);
  const maxval = parseInt(readToken(state), 10);

  if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid PGM dimensions: ${width} x ${height}.`);
  }
  if (isNaN(maxval) || maxval <= 0 || maxval > 65535) {
    throw new Error(`Invalid PGM maxval: ${maxval}. Must be 1–65535.`);
  }

  // For P5, exactly one whitespace byte separates maxval from binary pixel data.
  // `readToken` leaves `state.pos` pointing at that separator byte.
  if (magic === 'P5') {
    state.pos++; // advance past the single separator byte
  }

  // --- Decode pixels ---
  const totalPixels  = width * height;
  const rgbaBuffer   = new Uint8ClampedArray(totalPixels * 4);

  /**
   * Normalises a raw pixel value to the 0–255 range.
   * When maxval is 255, no scaling is needed (identity).
   */
  const normalize = (raw: number): number =>
    maxval === 255 ? raw : Math.round((raw / maxval) * 255);

  if (magic === 'P5') {
    // Binary: 1 byte per pixel for 8-bit maps, 2 bytes big-endian for 16-bit.
    const is16bit = maxval > 255;

    for (let i = 0; i < totalPixels; i++) {
      let rawValue: number;

      if (is16bit) {
        // Big-endian 16-bit sample.
        rawValue = (state.data[state.pos] << 8) | state.data[state.pos + 1];
        state.pos += 2;
      } else {
        rawValue = state.data[state.pos];
        state.pos++;
      }

      const gray = normalize(rawValue);
      const idx  = i * 4;
      rgbaBuffer[idx]     = gray; // R
      rgbaBuffer[idx + 1] = gray; // G
      rgbaBuffer[idx + 2] = gray; // B
      rgbaBuffer[idx + 3] = 255;  // A (fully opaque)
    }
  } else {
    // ASCII (P2): each pixel is a whitespace-separated decimal string.
    for (let i = 0; i < totalPixels; i++) {
      const gray = normalize(parseInt(readToken(state), 10));
      const idx  = i * 4;
      rgbaBuffer[idx]     = gray;
      rgbaBuffer[idx + 1] = gray;
      rgbaBuffer[idx + 2] = gray;
      rgbaBuffer[idx + 3] = 255;
    }
  }

  // --- Render to canvas and export PNG ---
  const canvas    = document.createElement('canvas');
  canvas.width    = width;
  canvas.height   = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to obtain 2D canvas context.');

  ctx.putImageData(new ImageData(rgbaBuffer, width, height), 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob() returned null.'))),
      'image/png'
    );
  });

  return { blob, width, height };
}

// ============================================================
// UTILITY: Get dimensions from a standard image file
// ============================================================

/**
 * Loads a browser-native image file (JPEG, PNG, WebP, etc.) into a temporary
 * `<img>` element in order to read its intrinsic pixel dimensions.
 *
 * @param file - Any image File the browser can decode natively.
 * @returns A Promise resolving to `{ width, height }` in pixels.
 * @throws {Error} If the browser cannot decode the file.
 */
export function getImageDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img       = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Browser could not decode image: ${file.name}`));
    };

    img.src = objectUrl;
  });
}
