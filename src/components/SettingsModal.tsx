import { useId, useState } from "react";
import * as api from "@/lib/api";
import type { ExtensionSet, Extensions, Settings } from "@/lib/types";
import { GlassModal } from "./ui/GlassModal";
import { ModalCloseButton } from "./ui/ModalCloseButton";
import { PrimaryButton } from "./ui/PrimaryButton";
import { SecondaryButton } from "./ui/SecondaryButton";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
  onDocsChanged: () => void;
  extensions: Extensions | null;
}

const inputCls =
  "mt-1 w-full rounded-md border border-hairline bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-accent";

export function SettingsModal({ settings, onSave, onClose, onDocsChanged, extensions }: Props) {
  const titleId = useId();
  const [s, setS] = useState(settings);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 打开配置目录（没有就先建好骨架和说明） */
  async function openConfig(dir: string | null) {
    try {
      await api.openPath(await api.ensureConfigDir(dir));
    } catch (err) {
      setInfo(String(err));
    }
  }

  async function showInfo() {
    const i = await api.dbInfo();
    setInfo(
      `${i.docs} 份文档 · ${i.chunks} 个片段 · ${i.sessions} 个会话 · ${(i.dbSizeBytes / 1048576).toFixed(1)} MB\n` +
        `数据库：${i.dbPath}\n助手保存的文件：${i.saveDir}`,
    );
  }

  return (
    <GlassModal open onClose={onClose} labelledBy={titleId} widthClassName="w-full max-w-lg">
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-text">
          设置
        </h2>
        <ModalCloseButton onClick={onClose} />
      </div>

      <div className="space-y-4 px-5 py-4 text-[12px] text-text-2">
        <label className="block">
          接口地址
          <input className={inputCls} value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} />
          <span className="mt-1 block text-text-4">任何 Anthropic 兼容接口都行</span>
        </label>
        <label className="block">
          API Key
          <input
            type="password"
            className={inputCls}
            value={s.apiKey}
            onChange={(e) => setS({ ...s, apiKey: e.target.value })}
          />
          <span className="mt-1 block text-text-4">只存在本机数据库里；提问时会把问题和检索到的片段发给这个接口</span>
        </label>
        <div className="flex gap-3">
          <label className="block flex-1">
            模型
            <input className={inputCls} value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} />
          </label>
          <label className="block w-32">
            每次检索片段数
            <input
              type="number"
              min={3}
              max={12}
              className={inputCls}
              value={s.topK}
              onChange={(e) => setS({ ...s, topK: Number(e.target.value) || 6 })}
            />
          </label>
        </div>

        <div>
          <div className="mb-1.5 text-text-2">技能与 MCP 服务</div>
          <div className="space-y-2">
            <ExtRow title="用户级" hint="对所有对话生效" set={extensions?.user ?? null} onOpen={() => openConfig(null)} />
            {settings.workspace ? (
              <ExtRow
                title="文件夹级"
                hint={settings.workspace.split("/").pop() ?? ""}
                set={extensions?.project ?? null}
                onOpen={() => openConfig(settings.workspace)}
              />
            ) : (
              <p className="text-text-4">选了工作文件夹后，那个文件夹里的 .docagent 也会被加载。</p>
            )}
          </div>
          <p className="mt-1.5 text-text-4">改完配置后开一个新对话生效。</p>
        </div>

        {info && <pre className="num whitespace-pre-wrap break-all rounded-md bg-bg p-3 text-[11px] text-text-3">{info}</pre>}
      </div>

      <div className="flex items-center gap-2 border-t border-hairline px-5 py-3.5">
        <button className="text-[12px] text-text-3 hover:text-text" onClick={() => void showInfo()}>
          存储信息
        </button>
        <button
          className="text-[12px] text-danger"
          onClick={() => {
            if (confirm("会删掉所有文档和索引（会话保留），确定？")) {
              void api.resetIndex().then(() => {
                onDocsChanged();
                setInfo("索引已清空");
              });
            }
          }}
        >
          清空索引
        </button>
        <span className="flex-1" />
        <SecondaryButton size="sm" onClick={onClose}>
          取消
        </SecondaryButton>
        <PrimaryButton
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onSave(s).finally(() => setSaving(false));
          }}
        >
          {saving ? "连接中…" : "保存并连接"}
        </PrimaryButton>
      </div>
    </GlassModal>
  );
}

function ExtRow({
  title,
  hint,
  set,
  onOpen,
}: {
  title: string;
  hint: string;
  set: ExtensionSet | null;
  onOpen: () => void;
}) {
  const items = set ? [...set.skills.map((n) => `技能 · ${n}`), ...set.mcp.map((n) => `MCP · ${n}`)] : [];
  return (
    <div className="rounded-lg border border-hairline px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-text">{title}</span>
        <span className="min-w-0 flex-1 truncate text-text-4">{hint}</span>
        <button className="text-accent hover:underline" onClick={onOpen}>
          打开文件夹
        </button>
      </div>
      {items.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {items.map((t) => (
            <span key={t} className="rounded-full bg-segment-bg px-2 py-0.5 text-[11px] text-text-2">
              {t}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-text-4">还没有技能或 MCP 服务</div>
      )}
    </div>
  );
}
