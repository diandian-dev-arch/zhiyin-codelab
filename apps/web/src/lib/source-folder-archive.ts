import { Zip, ZipDeflate } from 'fflate';
import { sourceImportLimits } from '@codelab/contracts/source';

export async function archiveSourceFolder(
  entries: readonly File[],
  options: { signal: AbortSignal; onProgress: (current: number, total: number) => void },
): Promise<{ file: File; fileCount: number; skippedCount: number } | undefined> {
  if (options.signal.aborted) return;
  const ignored = /^(node_modules|\.git|dist|build|coverage|vendor|__pycache__|\.venv|venv|__MACOSX)$/i;
  const sensitive = /^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|credential|secret|^id_rsa/i;
  const files = entries.filter(file => {
    const path = file.webkitRelativePath || file.name;
    return !path.split('/').some(part => ignored.test(part) || sensitive.test(part)) && !/\.(pem|key|p12|pfx)$/i.test(path);
  });
  if (files.length > sourceImportLimits.entries) throw new Error('排除依赖后的文件夹仍超过 20,000 个文件，请精简后重试。');
  if (!files.length) throw new Error('文件夹中没有可保存的文件，依赖、构建产物和常见敏感配置会在本地跳过。');
  if (files.reduce((total, file) => total + file.size, 0) > sourceImportLimits.expandedBytes) throw new Error('排除依赖后的文件夹仍超过 500 MB，请精简资源后重试。');

  const chunks: ArrayBuffer[] = [];
  let zipError: Error | undefined;
  let compressedBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const archive = new Zip((failure, chunk) => {
    if (failure) { zipError = failure; return; }
    compressedBytes += chunk.length;
    if (compressedBytes > sourceImportLimits.zipBytes) { zipError = new Error('文件夹打包后超过 100 MB，请精简大文件后重试。'); return; }
    chunks.push(chunk.slice().buffer as ArrayBuffer);
  });
  const cancel = () => {
    archive.terminate();
    void reader?.cancel().catch(() => {});
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (let index = 0; index < files.length; index++) {
      if (options.signal.aborted) return;
      const file = files[index];
      options.onProgress(index + 1, files.length);
      if (options.signal.aborted) return;
      const entry = new ZipDeflate(file.webkitRelativePath || file.name, { level: 3 });
      archive.add(entry);
      reader = file.stream().getReader();
      try {
        while (!options.signal.aborted) {
          const part = await reader.read();
          if (options.signal.aborted) return;
          if (part.done) { entry.push(new Uint8Array(), true); break; }
          entry.push(part.value);
          if (zipError) throw zipError;
        }
      } finally { reader.releaseLock(); reader = undefined; }
      if (zipError) throw zipError;
    }
    if (options.signal.aborted) return;
    archive.end();
    if (zipError) throw zipError;
    const folderName = (files[0].webkitRelativePath || 'project').split('/')[0];
    return {
      file: new File(chunks, `${folderName}.zip`, { type: 'application/zip' }),
      fileCount: files.length,
      skippedCount: entries.length - files.length,
    };
  } finally {
    options.signal.removeEventListener('abort', cancel);
    archive.terminate();
  }
}
