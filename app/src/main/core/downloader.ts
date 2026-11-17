import fs from 'node:fs';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export interface DownloadProgress {
  completed: number;
  total: number | null;
  percent: number | null;
}

export async function downloadFile(
  url: string,
  destination: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<void> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const total = contentLengthHeader ? Number(contentLengthHeader) : null;
  let completed = 0;

  const reader = response.body.getReader();
  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        completed += value.byteLength;
        if (options.onProgress) {
          const percent = total && total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null;
          options.onProgress({ completed, total, percent });
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });

  const fileStream = fs.createWriteStream(destination);
  await finished(nodeStream.pipe(fileStream));
}
