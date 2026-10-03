import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/api";
import { chunkPages } from "../lib/chunk";
import { kindFromName, parseFile } from "../lib/parse";
import { embed } from "../lib/provider";
import type { Doc, Settings } from "../lib/types";

interface Props {
  docs: Doc[];
  settings: Settings;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}

export function DocPanel({ docs, settings, selected, onToggleSelect, onChanged, onError }: Props) {
  const [progress, setProgress] = useState<string | null>(null);

  async function importFiles() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "文档", extensions: ["pdf", "docx", "md", "markdown", "txt"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];

    for (const [i, path] of paths.entries()) {
      const name = path.split("/").pop() ?? path;
      try {
        setProgress(`(${i + 1}/${paths.length}) 读取 ${name}`);
        const bytes = new Uint8Array(await api.readFileBytes(path));

        setProgress(`(${i + 1}/${paths.length}) 解析 ${name}`);
        const parsed = await parseFile(name, bytes);
        const chunks = chunkPages(parsed.pages);
        if (!chunks.length) throw new Error("解析后没有内容");

        setProgress(`(${i + 1}/${paths.length}) 向量化 ${chunks.length} 个片段`);
        const vectors = await embed(chunks.map((c) => c.text), settings);

        setProgress(`(${i + 1}/${paths.length}) 写入索引`);
        await api.addDocument(
          name,
          path,
          kindFromName(name),
          parsed.pageCount,
          chunks.map((c, idx) => ({ idx: c.idx, page: c.page, text: c.text, embedding: vectors[idx] })),
        );
        onChanged();
      } catch (err) {
        onError(`${name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setProgress(null);
  }

  async function remove(doc: Doc) {
    try {
      await api.deleteDocument(doc.id);
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <aside className="panel docs">
      <header>
        <h2>文档库</h2>
        <button onClick={importFiles} disabled={!!progress} className="primary">
          {progress ? "导入中…" : "+ 导入"}
        </button>
      </header>

      {progress && <div className="progress">{progress}</div>}

      {!docs.length && !progress && (
        <p className="empty">
          还没有文档。<br />
          支持 PDF / DOCX / Markdown / TXT。
        </p>
      )}

      <ul className="doclist">
        {docs.map((d) => (
          <li key={d.id} className={selected.has(d.id) ? "sel" : ""}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(d.id)}
                onChange={() => onToggleSelect(d.id)}
              />
              <span className="title" title={d.path ?? d.title}>
                {d.title}
              </span>
            </label>
            <div className="meta">
              <span className="kind">{d.kind}</span>
              {d.pages ? <span>{d.pages} 页</span> : null}
              <span>{d.chunkCount} 片段</span>
              <button className="link danger" onClick={() => remove(d)}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>

      {docs.length > 0 && (
        <footer className="hint">
          {selected.size ? `只在选中的 ${selected.size} 份里检索` : "不勾选则检索全部"}
        </footer>
      )}
    </aside>
  );
}
