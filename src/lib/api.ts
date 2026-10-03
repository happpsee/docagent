/** Rust 命令的封装。前端只通过这里碰 Rust。 */
import { invoke } from "@tauri-apps/api/core";
import type { ChunkIn, Doc, DocKind, SearchHit } from "./types";

interface RawDoc {
  id: string;
  title: string;
  path: string | null;
  kind: string;
  pages: number | null;
  chunk_count: number;
  created_at: number;
}

interface RawHit {
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  idx: number;
  page: number | null;
  text: string;
  distance: number;
}

export async function addDocument(
  title: string,
  path: string | null,
  kind: DocKind,
  pages: number | null,
  chunks: ChunkIn[],
): Promise<string> {
  return invoke<string>("add_document", { title, path, kind, pages, chunks });
}

export async function listDocuments(): Promise<Doc[]> {
  const raw = await invoke<RawDoc[]>("list_documents");
  return raw.map((d) => ({
    id: d.id,
    title: d.title,
    path: d.path,
    kind: d.kind as DocKind,
    pages: d.pages,
    chunkCount: d.chunk_count,
    createdAt: d.created_at,
  }));
}

export async function deleteDocument(docId: string): Promise<void> {
  await invoke("delete_document", { docId });
}

export async function search(
  embedding: number[],
  k: number,
  docIds?: string[],
): Promise<SearchHit[]> {
  const raw = await invoke<RawHit[]>("search", { embedding, k, docIds: docIds ?? null });
  return raw.map((h) => ({
    chunkId: h.chunk_id,
    docId: h.doc_id,
    docTitle: h.doc_title,
    idx: h.idx,
    page: h.page,
    text: h.text,
    distance: h.distance,
  }));
}

export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });
export const resetIndex = () => invoke<void>("reset_index");
export const readFileBytes = (path: string) => invoke<number[]>("read_file_bytes", { path });
export const dbInfo = () =>
  invoke<{
    docs: number;
    chunks: number;
    embeddingDim: string | null;
    dbPath: string;
    dbSizeBytes: number;
  }>("db_info");
export const writeFileText = (path: string, content: string) =>
  invoke<void>("write_file_text", { path, content });
