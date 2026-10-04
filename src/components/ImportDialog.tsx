import { useId, useState } from "react";
import type { Book, ImportItem, ScanItem } from "@/lib/types";
import { GlassModal } from "./ui/GlassModal";
import { PrimaryButton } from "./ui/PrimaryButton";
import { SecondaryButton } from "./ui/SecondaryButton";

/** 一起选进来的、来自同一个文件夹的几个零散文件 */
export interface LooseGroup {
  folder: string;
  name: string;
  files: string[];
  /** 里面有没有 PDF：PDF 多半自成一本，默认就不合 */
  hasPdf: boolean;
}

type Mode = ImportItem["mode"];
interface Choice {
  mode: Mode;
  label: string;
  hint?: string;
}

/** 这些格式的文件自己就是一本书；其它的（Markdown、文本、Word）常常是一个整体里的一篇 */
const SELF_CONTAINED = new Set(["epub", "mobi", "fb2", "cbz", "pdf"]);

/** 把用户选的 / 拖进来的路径整理成「不用问就能导入的」和「要问一下怎么归成书的」 */
export function planImport(scan: ScanItem[], books: Book[]) {
  const ready: ImportItem[] = [];
  const folders: { item: ScanItem; choices: Choice[]; initial: Mode; book: Book | null }[] = [];
  const empty: string[] = [];
  const loose = new Map<string, LooseGroup>();

  for (const it of scan) {
    if (!it.isDir) {
      // 所在文件夹已经是一本书：直接并进去。自成一本的格式：各算各的
      const dir = it.path.slice(0, it.path.lastIndexOf("/")) || "/";
      if (it.parentBook || !it.kind || (it.kind !== "pdf" && SELF_CONTAINED.has(it.kind))) {
        ready.push({ path: it.path, mode: "auto" });
        continue;
      }
      const g = loose.get(dir) ?? { folder: dir, name: dir.split("/").pop() || dir, files: [], hasPdf: false };
      g.files.push(it.path);
      g.hasPdf ||= it.kind === "pdf";
      loose.set(dir, g);
      continue;
    }
    if (it.total === 0) {
      empty.push(it.name);
      continue;
    }
    const book = it.bookId ? (books.find((b) => b.id === it.bookId) ?? null) : null;
    if (book) {
      // 已经是书架上的一本书。它本来就跟着文件夹走的，直接更新；
      // 只收了手动加的那几篇的，问一下要不要把文件夹里别的也加进来
      if (book.scan !== "none" || it.total <= book.docs.length) {
        ready.push({ path: it.path, mode: "auto" });
        continue;
      }
      const choices: Choice[] = [{ mode: "auto", label: `只更新已有的 ${book.docs.length} 篇` }];
      if (it.direct > 0) choices.push({ mode: "book-flat", label: `把这一层的 ${it.direct} 个文件都加进来` });
      if (it.total > it.direct) choices.push({ mode: "book", label: `连子文件夹一起，共 ${it.total} 个文件都加进来` });
      folders.push({ item: it, choices, initial: "auto", book });
      continue;
    }
    if (it.total === 1) {
      ready.push({ path: it.path, mode: "each" });
      continue;
    }
    const nested = it.total > it.direct;
    const choices: Choice[] = [];
    if (!nested) choices.push({ mode: "book", label: `当成一本书（${it.total} 篇）` });
    else {
      if (it.direct >= 2) choices.push({ mode: "book-flat", label: `只要这一层的 ${it.direct} 个文件，当成一本书` });
      choices.push({ mode: "book", label: `连子文件夹一起当成一本书（${it.total} 篇）`, hint: it.total > 60 ? "篇数很多，目录会很长" : undefined });
      if (it.subfolders.length >= 1) {
        choices.push({
          mode: "subfolders",
          label: `每个子文件夹各算一本（${it.subfolders.length} 本${it.direct ? `，这一层的 ${it.direct} 个文件各算各的` : ""}）`,
        });
      }
    }
    choices.push({ mode: "each", label: `每个文件各算一本（${it.total} 本）` });
    // 默认：全是电子书/PDF 的文件夹是个书库，各算各的；一堆子文件夹的也是书库；
    // 很大的目录树默认只取这一层，免得出来一本几百篇的书
    const initial: Mode = it.selfContained
      ? it.direct === 0 && it.subfolders.length >= 2
        ? "subfolders"
        : "each"
      : it.direct === 0 && it.subfolders.length >= 2
        ? "subfolders"
        : nested && it.direct >= 2 && it.total > 40
          ? "book-flat"
          : "book";
    folders.push({ item: it, choices, initial: choices.some((c) => c.mode === initial) ? initial : choices[0].mode, book: null });
  }

  const groups: LooseGroup[] = [];
  for (const g of loose.values()) {
    if (g.files.length >= 2) groups.push(g);
    else ready.push({ path: g.files[0], mode: "auto" });
  }
  return { ready, folders, groups, empty };
}

interface Props {
  plan: ReturnType<typeof planImport>;
  onCancel: () => void;
  onConfirm: (items: ImportItem[]) => void;
}

/** 导入前问一句：文件夹（或者同一个文件夹里的几个文件）怎么归成书 */
export function ImportDialog({ plan, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const [modes, setModes] = useState<Record<string, Mode>>(() =>
    Object.fromEntries(plan.folders.map((f) => [f.item.path, f.initial])),
  );
  const [merge, setMerge] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(plan.groups.map((g) => [g.folder, !g.hasPdf])),
  );

  function confirm() {
    const items: ImportItem[] = [...plan.ready];
    // 没选过的按默认值（状态里万一没有这一项，也不会发一个没有 mode 的请求出去）
    for (const f of plan.folders) items.push({ path: f.item.path, mode: modes[f.item.path] ?? f.initial });
    for (const g of plan.groups) {
      if (merge[g.folder] ?? !g.hasPdf) items.push({ path: g.folder, mode: "book", files: g.files });
      else for (const path of g.files) items.push({ path, mode: "auto" });
    }
    onConfirm(items);
  }

  const radio = "mt-0.5 accent-[var(--color-accent)]";
  const row = "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-2 hover:bg-nav-card";

  return (
    <GlassModal open onClose={onCancel} labelledBy={titleId} widthClassName="w-full max-w-[520px]">
      <div className="px-5 pt-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-text">
          怎么放到书架上？
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-text-3">
          一个文件夹可以是一本书，里面的文件是它的各篇：笔记、对话、透视都按书来。选错了之后也能在书的详情里拆开或者再加。
        </p>
      </div>
      <div className="max-h-[56vh] space-y-4 overflow-y-auto px-5 py-4">
        {plan.folders.map((f) => (
          <fieldset key={f.item.path}>
            <legend className="text-[13px] font-medium text-text">
              {f.book ? `《${f.book.title}》已经在书架上` : `「${f.item.name}」`}
              <span className="ml-2 font-normal text-text-4">
                {f.item.direct} 个文件
                {f.item.total > f.item.direct ? `，另有 ${f.item.subfolders.length} 个子文件夹（共 ${f.item.total} 个）` : ""}
              </span>
            </legend>
            <div className="mt-1.5">
              {f.choices.map((c) => (
                <label key={c.mode} className={row}>
                  <input
                    type="radio"
                    className={radio}
                    name={f.item.path}
                    checked={modes[f.item.path] === c.mode}
                    onChange={() => setModes((m) => ({ ...m, [f.item.path]: c.mode }))}
                  />
                  <span>
                    {c.label}
                    {c.hint && <span className="ml-1.5 text-[12px] text-text-4">{c.hint}</span>}
                  </span>
                </label>
              ))}
            </div>
            {f.item.truncated && <p className="mt-1 px-2 text-[12px] text-warm">这个文件夹层数很深，超过 8 层的文件没有算进来。</p>}
          </fieldset>
        ))}
        {plan.groups.map((g) => (
          <fieldset key={g.folder}>
            <legend className="text-[13px] font-medium text-text">
              「{g.name}」里的 {g.files.length} 个文件
              <span className="ml-2 font-normal text-text-4">{g.files.map((f) => f.split("/").pop()).slice(0, 3).join("、")}{g.files.length > 3 ? " 等" : ""}</span>
            </legend>
            <div className="mt-1.5">
              <label className={row}>
                <input type="radio" className={radio} name={g.folder} checked={merge[g.folder]} onChange={() => setMerge((m) => ({ ...m, [g.folder]: true }))} />
                合成一本书《{g.name}》，这几个文件是它的各篇
              </label>
              <label className={row}>
                <input type="radio" className={radio} name={g.folder} checked={!merge[g.folder]} onChange={() => setMerge((m) => ({ ...m, [g.folder]: false }))} />
                每个文件各算一本
              </label>
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3.5">
        <SecondaryButton size="sm" onClick={onCancel}>
          取消
        </SecondaryButton>
        <PrimaryButton size="sm" onClick={confirm}>
          导入
        </PrimaryButton>
      </div>
    </GlassModal>
  );
}
