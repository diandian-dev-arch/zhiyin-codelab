import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { it, expect } from "vitest";
import { importModelConfig } from "../scripts/import-model-config";

it("imports only valid supplied model fields and preserves unrelated local configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codelab-model-config-"));
  try {
    const source = path.join(directory, "supplied.env");
    await writeFile(
      source,
      "MODEL_BASE_URL=https://example.invalid/v1\nMODEL_NAME=fixture\nMODEL_API_KEY=test-only\nDATABASE_URL=must-not-import\n",
    );
    await writeFile(
      path.join(directory, ".env"),
      "# keep this\nDATABASE_URL=keep-existing\nMODEL_API_KEY=old-test-only\nMODEL_TEMPERATURE=0\nSOURCE_MODEL_CONTEXT_TOKENS=128000\nSOURCE_MODEL_MAX_OUTPUT_TOKENS=8000\nSOURCE_MODEL_TOKENIZER=o200k_base\n",
    );
    const result = await importModelConfig(source, directory);
    const text = await readFile(path.join(directory, ".env"), "utf8");
    expect(text).toContain("# keep this");
    expect(parseEnv(text)).toEqual({
      DATABASE_URL: "keep-existing",
      MODEL_BASE_URL: "https://example.invalid/v1",
      MODEL_NAME: "fixture",
      MODEL_API_KEY: "test-only",
    });
    expect(JSON.stringify(result)).not.toContain("test-only");
    await writeFile(source, "MODEL_API_KEY=incomplete-test-only");
    await expect(importModelConfig(source, directory)).rejects.toThrow(
      "MODEL_CONFIG_FIELD_MISSING",
    );
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe(text);
    await writeFile(
      source,
      "MODEL_BASE_URL=https://example.invalid/v1\nMODEL_NAME=fixture\nMODEL_API_KEY=test-only\nSOURCE_MODEL_CONTEXT_TOKENS=32768\nSOURCE_MODEL_MAX_OUTPUT_TOKENS=4096\nSOURCE_MODEL_TOKENIZER=cl100k_base\n",
    );
    await importModelConfig(source, directory);
    const configured = await readFile(path.join(directory, ".env"), "utf8");
    expect(parseEnv(configured)).toMatchObject({
      SOURCE_MODEL_CONTEXT_TOKENS: "32768",
      SOURCE_MODEL_MAX_OUTPUT_TOKENS: "4096",
      SOURCE_MODEL_TOKENIZER: "cl100k_base",
    });
    await writeFile(
      source,
      "MODEL_BASE_URL=https://example.invalid/v1\nMODEL_NAME=fixture\nMODEL_API_KEY=test-only\nSOURCE_MODEL_CONTEXT_TOKENS=16384\n",
    );
    await expect(importModelConfig(source, directory)).rejects.toThrow(
      "SOURCE_CONTEXT_CONFIGURATION_INVALID",
    );
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe(
      configured,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
