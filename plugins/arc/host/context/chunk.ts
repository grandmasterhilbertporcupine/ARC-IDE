import { randomUUID } from "node:crypto";
import type { ExperimentalHostContextEmbeddings } from "@get-bb/plugin-sdk/host";
import { hostContextLimits } from "../../host-context-contract.js";
import { hashText, type SourceRow, type StoredChunk } from "./store.js";
import { SourceReadFailure } from "./scan.js";

export type EmbeddingBinding = { manifestDigest: string; generation: string };
export const embeddingText = (name: string, text: string) =>
  `Source: ${Array.from(name).slice(-48).join("")}\n${text}`;

function safeEnd(text: string, start: number, length: number): number {
  let end = Math.min(text.length, start + length);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  const newline = text.lastIndexOf("\n", end - 1);
  if (newline > start + Math.floor((end - start) / 2)) end = newline + 1;
  return Math.max(start + 1, end);
}

function chunk(
  source: SourceRow,
  sha: string,
  text: string,
  start: number,
  end: number,
  startLine: number,
  tokenCount: number | null,
): StoredChunk {
  const excerpt = text.slice(start, end);
  return {
    id: `chunk_${hashText(JSON.stringify(["text-v1", source.id, source.generation, sha, start, end, tokenCount])).slice(0, 48)}`,
    start,
    end,
    startLine,
    endLine: startLine + (excerpt.match(/\n/gu)?.length ?? 0),
    text: excerpt,
    tokenCount,
    vector: null,
  };
}

export function lexicalChunks(
  source: SourceRow,
  sha: string,
  text: string,
): StoredChunk[] {
  const chunks: StoredChunk[] = [];
  let start = 0,
    line = 1;
  while (start < text.length) {
    const end = safeEnd(text, start, 1600);
    const value = chunk(source, sha, text, start, end, line, null);
    chunks.push(value);
    if (chunks.length > hostContextLimits.maxChunksPerSource)
      throw new SourceReadFailure("chunk_count_limit");
    start = end;
    line = value.endLine;
  }
  return chunks;
}

export async function exactChunks(
  source: SourceRow,
  sha: string,
  text: string,
  capability: ExperimentalHostContextEmbeddings,
  binding: EmbeddingBinding,
  signal: AbortSignal,
  current: () => boolean,
): Promise<StoredChunk[]> {
  const chunks: StoredChunk[] = [];
  let start = 0,
    line = 1;
  while (start < text.length) {
    signal.throwIfAborted();
    if (!current()) throw new SourceReadFailure("source_generation_changed");
    let end = safeEnd(text, start, 1600);
    let tokenCount: number;
    for (;;) {
      const requestId = randomUUID();
      const result = await capability.countTokens(
        {
          requestId,
          expectedManifestDigest: binding.manifestDigest,
          expectedGeneration: binding.generation,
          items: [
            {
              id: "chunk",
              text: embeddingText(source.name, text.slice(start, end)),
            },
          ],
        },
        { signal },
      );
      if (result.state === "failed" && result.error.code === "stop_unresolved")
        throw new SourceReadFailure("embedding_stop_unresolved");
      signal.throwIfAborted();
      if (!current()) throw new SourceReadFailure("source_generation_changed");
      if (result.state === "failed")
        throw new SourceReadFailure(`embedding_${result.error.code}`);
      if (
        result.generation !== binding.generation ||
        result.requestId !== requestId ||
        result.manifestDigest !== binding.manifestDigest ||
        result.items.length !== 1 ||
        result.items[0]?.id !== "chunk"
      )
        throw new SourceReadFailure("embedding_binding_changed");
      tokenCount = result.items[0].tokenCount;
      if (tokenCount <= 256) break;
      if (end - start <= 2) throw new SourceReadFailure("token_prefix_limit");
      end = safeEnd(text, start, Math.floor((end - start) / 2));
    }
    const value = chunk(source, sha, text, start, end, line, tokenCount);
    chunks.push(value);
    if (chunks.length > hostContextLimits.maxChunksPerSource)
      throw new SourceReadFailure("chunk_count_limit");
    start = end;
    line = value.endLine;
  }
  return chunks;
}

export async function embedChunks(
  name: string,
  chunks: StoredChunk[],
  capability: ExperimentalHostContextEmbeddings,
  binding: EmbeddingBinding,
  signal: AbortSignal,
): Promise<Array<{ id: string; vector: number[] }>> {
  const requestId = randomUUID();
  const result = await capability.embed(
    {
      requestId,
      expectedManifestDigest: binding.manifestDigest,
      expectedGeneration: binding.generation,
      items: chunks.map((item) => ({
        id: item.id,
        text: embeddingText(name, item.text),
      })),
    },
    { signal },
  );
  if (result.state === "failed" && result.error.code === "stop_unresolved")
    throw new SourceReadFailure("embedding_stop_unresolved");
  signal.throwIfAborted();
  if (result.state === "failed")
    throw new SourceReadFailure(`embedding_${result.error.code}`);
  if (
    result.generation !== binding.generation ||
    result.requestId !== requestId ||
    result.manifestDigest !== binding.manifestDigest ||
    result.items.length !== chunks.length
  )
    throw new SourceReadFailure("embedding_binding_changed");
  return result.items.map((item, index) => {
    if (
      item.id !== chunks[index]?.id ||
      item.tokenCount !== chunks[index]?.tokenCount
    )
      throw new SourceReadFailure("embedding_binding_changed");
    return { id: item.id, vector: item.vector };
  });
}
