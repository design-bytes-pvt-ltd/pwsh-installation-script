import type { ReferenceImage } from './state';

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];
const ACCEPTED_EXTENSION = /\.(png|jpe?g)$/i;
/** For the file picker's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = '.png,.jpg,.jpeg,image/png,image/jpeg';

export class ReferenceImageError extends Error {
  override name = 'ReferenceImageError';
}

const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Returns why `file` can't be used as a reference image, or null if it can. Pasted images have
 * no meaningful file name, so the extension check is optional.
 */
export function validateImageFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  { requireExtension = true }: { requireExtension?: boolean } = {}
): string | null {
  if (!ACCEPTED_TYPES.includes(file.type) || (requireExtension && !ACCEPTED_EXTENSION.test(file.name))) {
    return `"${file.name || 'This file'}" is not a PNG or JPEG image.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_IMAGE_BYTES) {
    return `"${file.name}" is ${formatMB(file.size)}; the limit is ${formatMB(MAX_IMAGE_BYTES)}.`;
  }
  return null;
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('empty result')));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Loads `src` into an <img> to prove it decodes, and returns its natural size. */
export function decodeImage(src: string): Promise<{ width: number; height: number; element: HTMLImageElement }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight, element: img });
      } else reject(new Error('zero size'));
    };
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

/** Validates, reads and decodes a PNG/JPEG file into a reference image (as a data URL). */
export async function readReferenceImage(
  file: File,
  options: { requireExtension?: boolean } = {}
): Promise<ReferenceImage> {
  const problem = validateImageFile(file, options);
  if (problem) throw new ReferenceImageError(problem);
  let src: string;
  try {
    src = await readAsDataURL(file);
  } catch {
    throw new ReferenceImageError(`Couldn't read "${file.name}".`);
  }
  try {
    const { width, height } = await decodeImage(src);
    return { src, name: file.name || 'Pasted image', width, height, bytes: file.size };
  } catch {
    throw new ReferenceImageError(`"${file.name || 'The image'}" is not a valid PNG or JPEG image.`);
  }
}
