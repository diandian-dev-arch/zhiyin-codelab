import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { archiveSourceFolder } from '../apps/web/src/lib/source-folder-archive';

// Scaled limits exercise exact boundaries without allocating a 500 MB fixture.
const { limits } = vi.hoisted(() => ({ limits: { entries: 4, expandedBytes: 128, zipBytes: 2048 } }));
vi.mock('../packages/contracts/src/source', () => ({ sourceImportLimits: limits }));
beforeEach(() => Object.assign(limits, { entries: 4, expandedBytes: 128, zipBytes: 2048 }));

function sourceFile(path: string, content = 'source') {
  const file = new File([content], path.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function prepare(files: File[], controller = new AbortController(), onProgress: (current: number, total: number) => void = vi.fn()) {
  return archiveSourceFolder(files, { signal: controller.signal, onProgress });
}

describe('browser source folder ZIP preparation', () => {
  it('keeps relative paths, UTF-8 and empty files in a real readable ZIP', async () => {
    const onProgress = vi.fn();
    const result = await prepare([
      sourceFile('课堂项目/src/main.ts', 'const n = 1;'),
      sourceFile('课堂项目/说明.md', '你好，源码'),
      sourceFile('课堂项目/empty.txt', ''),
    ], new AbortController(), onProgress);
    expect(result).toMatchObject({ fileCount: 3, skippedCount: 0 });
    expect(result!.file.name).toBe('课堂项目.zip');
    expect(result!.file.type).toBe('application/zip');
    const zipped = unzipSync(new Uint8Array(await result!.file.arrayBuffer()));
    expect(Object.keys(zipped)).toEqual(['课堂项目/src/main.ts', '课堂项目/说明.md', '课堂项目/empty.txt']);
    expect(strFromU8(zipped['课堂项目/说明.md'])).toBe('你好，源码');
    expect(zipped['课堂项目/empty.txt']).toHaveLength(0);
    expect(onProgress.mock.calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('preserves the current dependency, build-output and sensitive-path exclusions before capacity checks', async () => {
    const ignored = [
      'p/node_modules/x.ts', 'p/.git/config', 'p/dist/app.js', 'p/build/app.js',
      'p/coverage/a.js', 'p/vendor/a.php', 'p/__pycache__/a.pyc', 'p/.venv/a.py',
      'p/venv/a.py', 'p/__MACOSX/a.ts', 'p/.env', 'p/.env.local', 'p/.npmrc',
      'p/.pypirc', 'p/credentials.json', 'p/secret.txt', 'p/id_rsa.pub',
      'p/cert.pem', 'p/cert.KEY', 'p/cert.p12', 'p/cert.pfx',
    ].map(path => sourceFile(path, 'x'.repeat(256)));
    const result = await prepare([...ignored, sourceFile('p/src/main.ts')]);
    expect(result).toMatchObject({ fileCount: 1, skippedCount: ignored.length });
    const zipped = unzipSync(new Uint8Array(await result!.file.arrayBuffer()));
    expect(Object.keys(zipped)).toEqual(['p/src/main.ts']);
  });

  it('keeps the fallback archive and entry names for files without a relative directory', async () => {
    const result = await prepare([new File(['x'], 'main.ts')]);
    expect(result!.file.name).toBe('project.zip');
    expect(Object.keys(unzipSync(new Uint8Array(await result!.file.arrayBuffer())))).toEqual(['main.ts']);
  });

  it('rejects an empty or fully excluded selection with the existing Chinese message', async () => {
    for (const files of [[], [sourceFile('p/node_modules/x.ts')]]) {
      await expect(prepare(files)).rejects.toThrow('文件夹中没有可保存的文件，依赖、构建产物和常见敏感配置会在本地跳过。');
    }
  });

  it('accepts the exact file-count boundary and rejects one extra retained file', async () => {
    const files = Array.from({ length: limits.entries }, (_, index) => sourceFile(`p/${index}.ts`, 'x'));
    expect(await prepare(files)).toMatchObject({ fileCount: limits.entries });
    await expect(prepare([...files, sourceFile('p/extra.ts')])).rejects.toThrow('排除依赖后的文件夹仍超过 20,000 个文件，请精简后重试。');
  });

  it('accepts the exact expanded-byte boundary and rejects larger input before opening its stream', async () => {
    expect(await prepare([sourceFile('p/exact.ts', 'x'.repeat(limits.expandedBytes))])).toBeDefined();
    const file = sourceFile('p/large.ts', 'x'.repeat(limits.expandedBytes + 1));
    const stream = vi.spyOn(file, 'stream');
    await expect(prepare([file])).rejects.toThrow('排除依赖后的文件夹仍超过 500 MB，请精简资源后重试。');
    expect(stream).not.toHaveBeenCalled();
  });

  it('accepts the exact compressed-byte boundary and rejects one byte below the required ZIP size', async () => {
    const files = [sourceFile('p/main.ts')];
    const original = await prepare(files);
    limits.zipBytes = original!.file.size;
    expect((await prepare(files))!.file.size).toBe(limits.zipBytes);
    limits.zipBytes--;
    await expect(prepare(files)).rejects.toThrow('文件夹打包后超过 100 MB，请精简大文件后重试。');
  });

  it('does no work for a cancelled selection and stops before the next stream when cancelled from progress', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const file = sourceFile('p/main.ts');
    const stream = vi.spyOn(file, 'stream');
    const onProgress = vi.fn();
    expect(await prepare([file], cancelled, onProgress)).toBeUndefined();
    expect(onProgress).not.toHaveBeenCalled();
    const controller = new AbortController();
    expect(await prepare([file], controller, () => controller.abort())).toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
  });

  it('cancels a pending read, releases its lock and leaves a newer preparation unaffected', async () => {
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull() { reading(); return new Promise(() => {}); },
      cancel,
    });
    const file = sourceFile('old/main.ts');
    vi.spyOn(file, 'stream').mockReturnValue(stream);
    const controller = new AbortController();
    const old = prepare([file], controller);
    await started;
    controller.abort();
    const newer = prepare([sourceFile('new/main.ts')]);
    expect(await old).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect((await newer)!.file.name).toBe('new.zip');
  });

  it('preserves stream errors and releases the reader without returning a partial ZIP', async () => {
    const failure = new Error('本地文件无法读取');
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) { controller.error(failure); } });
    const file = sourceFile('p/main.ts');
    vi.spyOn(file, 'stream').mockReturnValue(stream);
    await expect(prepare([file])).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it('retains the production capacity contract rather than introducing a second set of limits', async () => {
    const actual = await vi.importActual<typeof import('../packages/contracts/src/source')>('../packages/contracts/src/source');
    expect(actual.sourceImportLimits).toMatchObject({ entries: 20_000, expandedBytes: 500 * 1024 * 1024, zipBytes: 100 * 1024 * 1024 });
  });
});
