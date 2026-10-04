import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, Database, Eye, EyeOff, Loader2, Puzzle, Search, Sparkles } from "lucide-react";
import * as api from "@/lib/api";
import type { ExtensionSet, Extensions, ProviderConfig, Settings } from "@/lib/types";
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

/** 内置的几家供应商。助手用的是 Anthropic 的接口格式，所以这里填的都是各家「Anthropic 兼容」的地址。
 *  models 是可以直接点选的型号；空着的需要自己填 */
const PROVIDERS: { id: string; name: string; baseUrl: string; models: string[]; hint: string }[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", models: ["deepseek-flash", "deepseek-v4-pro"], hint: "在 platform.deepseek.com 申请 API Key" },
  { id: "kimi", name: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/anthropic", models: [], hint: "在 platform.moonshot.cn 申请，模型名照它控制台里的写" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", models: [], hint: "在 open.bigmodel.cn 申请，模型名照它控制台里的写" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"], hint: "在 console.anthropic.com 申请" },
  { id: "custom", name: "自定义", baseUrl: "", models: [], hint: "任何 Anthropic 兼容的接口：填它的地址、Key 和模型名" },
];

type Section = "model" | "search" | "ext" | "data";
type Probe = { state: "idle" } | { state: "busy" } | { state: "ok"; text: string } | { state: "bad"; text: string };

const inputCls =
  "w-full rounded-md border border-hairline bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-accent placeholder:text-text-4";
const labelCls = "mb-1 block text-[12px] text-text-3";

/** 老设置里没有「哪一家」：按接口地址认出来，认不出就算自定义 */
function initial(settings: Settings): { active: string; providers: Record<string, ProviderConfig> } {
  const providers: Record<string, ProviderConfig> = {};
  for (const p of PROVIDERS) {
    providers[p.id] = settings.providers?.[p.id] ?? { baseUrl: p.baseUrl, apiKey: "", model: p.models[0] ?? "" };
  }
  let active = settings.provider && providers[settings.provider] ? settings.provider : null;
  if (!active) {
    active = PROVIDERS.find((p) => p.baseUrl && p.baseUrl === settings.baseUrl.trim().replace(/\/$/, ""))?.id ?? (settings.apiKey ? "custom" : "deepseek");
    if (settings.apiKey || settings.baseUrl !== PROVIDERS[0].baseUrl) {
      providers[active] = { baseUrl: settings.baseUrl || providers[active].baseUrl, apiKey: settings.apiKey, model: settings.model || providers[active].model };
    }
  }
  return { active, providers };
}

/** 设置：左边分类，右边内容。模型这一栏按供应商一行一行列出来——哪家填了 Key、正在用哪家一眼看得到，
 *  每家各记各的，换着用不用重填；填完可以先试一下通不通再保存 */
export function SettingsModal({ settings, onSave, onClose, onDocsChanged, extensions }: Props) {
  const titleId = useId();
  const [section, setSection] = useState<Section>("model");
  const [s, setS] = useState(settings);
  const [{ active, providers }, setModels] = useState(() => initial(settings));
  const [open, setOpen] = useState<string | null>(() => (settings.apiKey ? null : initial(settings).active));
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Record<string, Probe>>({});

  const patch = (id: string, p: Partial<ProviderConfig>) => {
    setModels((m) => ({ ...m, providers: { ...m.providers, [id]: { ...m.providers[id], ...p } } }));
    setProbe((x) => ({ ...x, [id]: { state: "idle" } }));
  };
  const usable = (c: ProviderConfig) => !!(c.apiKey.trim() && c.baseUrl.trim() && c.model.trim());
  const current = providers[active];
  const dirty =
    JSON.stringify({ ...s, provider: active, providers, baseUrl: current.baseUrl, apiKey: current.apiKey, model: current.model }) !==
    JSON.stringify({ ...settings, provider: settings.provider ?? active, providers: settings.providers ?? providers });

  async function test(id: string) {
    const c = providers[id];
    setProbe((x) => ({ ...x, [id]: { state: "busy" } }));
    try {
      const ms = await api.testModel(c.baseUrl, c.apiKey, c.model);
      setProbe((x) => ({ ...x, [id]: { state: "ok", text: `通了，用时 ${(ms / 1000).toFixed(1)} 秒` } }));
    } catch (err) {
      setProbe((x) => ({ ...x, [id]: { state: "bad", text: String(err) } }));
    }
  }

  async function testEmbed() {
    setProbe((x) => ({ ...x, embed: { state: "busy" } }));
    try {
      const dim = await api.testEmbedding(s.embedBaseUrl, s.embedApiKey, s.embedModel);
      setProbe((x) => ({ ...x, embed: { state: "ok", text: `通了，向量是 ${dim} 维` } }));
    } catch (err) {
      setProbe((x) => ({ ...x, embed: { state: "bad", text: String(err) } }));
    }
  }

  function save() {
    setSaving(true);
    const trimmed = Object.fromEntries(
      Object.entries(providers).map(([id, c]) => [id, { baseUrl: c.baseUrl.trim().replace(/\/$/, ""), apiKey: c.apiKey.trim(), model: c.model.trim() }]),
    );
    void onSave({ ...s, provider: active, providers: trimmed, ...trimmed[active] }).finally(() => setSaving(false));
  }

  const nav: [Section, string, typeof Sparkles][] = [
    ["model", "模型", Sparkles],
    ["search", "检索", Search],
    ["ext", "技能与 MCP", Puzzle],
    ["data", "数据", Database],
  ];

  return (
    <GlassModal open onClose={onClose} labelledBy={titleId} widthClassName="w-full max-w-[780px]">
      <div className="flex h-[560px] max-h-[82vh]">
        <nav className="flex w-[168px] shrink-0 flex-col gap-0.5 border-r border-hairline bg-bg-grad-b/60 p-3">
          <h2 id={titleId} className="px-2 pb-3 pt-1.5 text-[15px] font-semibold text-text">
            设置
          </h2>
          {nav.map(([id, name, Icon]) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${
                section === id ? "bg-nav-card-active text-text" : "text-text-2 hover:bg-nav-card"
              }`}
            >
              <Icon className="h-4 w-4 text-text-3" />
              {name}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <div className="text-[14px] font-medium text-text">{nav.find((n) => n[0] === section)?.[1]}</div>
            <ModalCloseButton onClick={onClose} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 text-[13px] text-text-2">
            {section === "model" && (
              <>
                <p className="pb-3 text-[12px] leading-relaxed text-text-3">
                  助手用哪家的模型。每家的 Key 各记各的，只存在这台电脑上；提问时，问题和检索到的片段会发给正在用的那一家。
                </p>
                <ul className="space-y-2">
                  {PROVIDERS.map((p) => {
                    const c = providers[p.id];
                    const isOpen = open === p.id;
                    const isActive = active === p.id;
                    const pr = probe[p.id] ?? { state: "idle" };
                    return (
                      <li key={p.id} className={`rounded-xl border ${isOpen ? "border-hairline-strong bg-surface-2" : "border-hairline"}`}>
                        <button className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${c.apiKey.trim() ? "bg-good" : "bg-track-idle"}`}
                            title={c.apiKey.trim() ? "已填 API Key" : "还没填 API Key"}
                          />
                          <span className="text-[13px] font-medium text-text">{p.name}</span>
                          {isActive && <span className="rounded-full bg-accent-dim px-1.5 py-px text-[10px] text-accent">正在用</span>}
                          <span className="num min-w-0 flex-1 truncate text-right text-[11px] text-text-4">{c.apiKey.trim() ? c.model : "未配置"}</span>
                          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        </button>
                        {isOpen && (
                          <div className="space-y-3 border-t border-hairline-soft px-3.5 pb-3.5 pt-3">
                            <div>
                              <span className={labelCls}>API Key</span>
                              <SecretInput value={c.apiKey} onChange={(v) => patch(p.id, { apiKey: v })} placeholder="sk-…" />
                              <span className="mt-1 block text-[11px] text-text-4">{p.hint}</span>
                            </div>
                            <div>
                              <span className={labelCls}>模型</span>
                              {p.models.length > 0 && (
                                <div className="mb-1.5 flex flex-wrap gap-1.5">
                                  {p.models.map((m) => (
                                    <button
                                      key={m}
                                      onClick={() => patch(p.id, { model: m })}
                                      className={`num rounded-full border px-2.5 py-1 text-[12px] ${
                                        c.model === m ? "border-accent bg-accent-dim text-accent" : "border-hairline text-text-2 hover:border-hairline-strong"
                                      }`}
                                    >
                                      {m}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <input
                                className={`${inputCls} num`}
                                value={c.model}
                                placeholder="模型名，照供应商控制台里的写"
                                onChange={(e) => patch(p.id, { model: e.target.value })}
                              />
                            </div>
                            <details open={p.id === "custom" || !c.baseUrl}>
                              <summary className="cursor-pointer select-none text-[12px] text-text-3 hover:text-text">接口地址</summary>
                              <input
                                className={`${inputCls} num mt-1.5`}
                                value={c.baseUrl}
                                placeholder="https://…（Anthropic 兼容的地址）"
                                onChange={(e) => patch(p.id, { baseUrl: e.target.value })}
                              />
                              {p.baseUrl && c.baseUrl !== p.baseUrl && (
                                <button className="mt-1 text-[11px] text-accent hover:underline" onClick={() => patch(p.id, { baseUrl: p.baseUrl })}>
                                  恢复默认地址
                                </button>
                              )}
                            </details>
                            <div className="flex items-center gap-2 pt-0.5">
                              <SecondaryButton size="sm" disabled={!usable(c) || pr.state === "busy"} onClick={() => void test(p.id)}>
                                {pr.state === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                测试连接
                              </SecondaryButton>
                              {!isActive && (
                                <SecondaryButton size="sm" disabled={!usable(c)} onClick={() => setModels((m) => ({ ...m, active: p.id }))}>
                                  用这一家
                                </SecondaryButton>
                              )}
                              <ProbeText p={pr} />
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {section === "search" && (
              <div className="space-y-4">
                <p className="text-[12px] leading-relaxed text-text-3">
                  助手在书架里找内容有两路：按字面找（不用配置，离线可用），和按意思找（要一个向量接口）。
                  不填向量接口也能用；填了以后换个说法也能找到，但书里的内容会发给这个接口来计算向量。
                </p>
                <div className="rounded-xl border border-hairline p-3.5">
                  <div className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-text">
                    <span className={`h-2 w-2 rounded-full ${s.embedApiKey.trim() ? "bg-good" : "bg-track-idle"}`} />
                    向量接口
                    <span className="text-[11px] font-normal text-text-4">可选，OpenAI 兼容的 /embeddings</span>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <span className={labelCls}>API Key</span>
                      <SecretInput value={s.embedApiKey} onChange={(v) => setS({ ...s, embedApiKey: v })} placeholder="不用语义检索就空着" />
                    </div>
                    <div className="flex gap-3">
                      <label className="block flex-1">
                        <span className={labelCls}>接口地址</span>
                        <input className={`${inputCls} num`} value={s.embedBaseUrl} onChange={(e) => setS({ ...s, embedBaseUrl: e.target.value })} />
                      </label>
                      <label className="block w-[170px]">
                        <span className={labelCls}>向量模型</span>
                        <input className={`${inputCls} num`} value={s.embedModel} onChange={(e) => setS({ ...s, embedModel: e.target.value })} />
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <SecondaryButton
                        size="sm"
                        disabled={!s.embedApiKey.trim() || !s.embedBaseUrl.trim() || !s.embedModel.trim() || probe.embed?.state === "busy"}
                        onClick={() => void testEmbed()}
                      >
                        {probe.embed?.state === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        测试连接
                      </SecondaryButton>
                      <ProbeText p={probe.embed ?? { state: "idle" }} />
                    </div>
                  </div>
                </div>
                <label className="flex items-center justify-between gap-3 rounded-xl border border-hairline px-3.5 py-3">
                  <span>
                    <span className="block text-[13px] text-text">每次检索取几段</span>
                    <span className="mt-0.5 block text-[12px] text-text-4">多了回答更全，也更费钱更慢</span>
                  </span>
                  <input
                    type="number"
                    min={3}
                    max={12}
                    className={`${inputCls} num w-20 text-center`}
                    value={s.topK}
                    onChange={(e) => setS({ ...s, topK: Math.min(12, Math.max(3, Number(e.target.value) || 6)) })}
                  />
                </label>
              </div>
            )}

            {section === "ext" && (
              <div className="space-y-2">
                <p className="pb-1 text-[12px] leading-relaxed text-text-3">
                  技能是写给助手的做事方法，MCP 服务是给它接的外部工具。放在配置文件夹里就会被加载；改完开一段新对话生效。
                </p>
                <ExtRow title="用户级" hint="对所有对话生效" set={extensions?.user ?? null} onOpen={() => openConfig(null)} />
                {settings.workspace ? (
                  <ExtRow
                    title="文件夹级"
                    hint={settings.workspace.split("/").pop() ?? ""}
                    set={extensions?.project ?? null}
                    onOpen={() => openConfig(settings.workspace)}
                  />
                ) : (
                  <p className="text-[12px] text-text-4">在输入框下面选了工作文件夹后，那个文件夹里的 .docagent 也会被加载。</p>
                )}
              </div>
            )}

            {section === "data" && <DataSection onDocsChanged={onDocsChanged} />}
          </div>

          <div className="flex items-center gap-2 border-t border-hairline px-5 py-3">
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-4">
              {usable(current) ? `正在用：${PROVIDERS.find((p) => p.id === active)?.name} · ${current.model}` : "还没有可用的模型：填好一家的 API Key 和模型名"}
            </span>
            <SecondaryButton size="sm" onClick={onClose}>
              {dirty ? "取消" : "关闭"}
            </SecondaryButton>
            <PrimaryButton size="sm" disabled={saving || !usable(current)} onClick={save}>
              {saving ? "连接中…" : "保存并连接"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </GlassModal>
  );

  /** 打开配置目录（没有就先建好骨架和说明） */
  function openConfig(dir: string | null) {
    void api.ensureConfigDir(dir).then(api.openPath).catch(() => {});
  }
}

/** 密钥输入框：默认遮住，可以点开看一眼 */
function SecretInput(p: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        type={shown ? "text" : "password"}
        className={`${inputCls} num pr-9`}
        value={p.value}
        placeholder={p.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => p.onChange(e.target.value)}
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-4 hover:text-text"
        aria-label={shown ? "遮住" : "显示"}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function ProbeText({ p }: { p: Probe }) {
  if (p.state === "ok") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-good">
        <Check className="h-3.5 w-3.5 shrink-0" />
        {p.text}
      </span>
    );
  }
  if (p.state === "bad") return <span className="min-w-0 break-all text-[12px] leading-snug text-danger">{p.text}</span>;
  return null;
}

/** 数据：存了多少、放在哪、重建索引 */
function DataSection({ onDocsChanged }: { onDocsChanged: () => void }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.dbInfo>> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api.dbInfo().then(setInfo, () => {});
  useEffect(load, []);
  const row = "flex items-baseline justify-between gap-4 border-b border-hairline-soft py-2 last:border-0";
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-hairline px-3.5 py-1">
        <div className={row}>
          <span className="text-text-3">书架</span>
          <span className="num text-text">{info ? `${info.books ?? "–"} 本 · ${info.docs} 篇 · ${info.chunks} 个片段` : "…"}</span>
        </div>
        <div className={row}>
          <span className="text-text-3">语义索引</span>
          <span className="num text-text">{info ? (info.embedModel ? `${info.vectors ?? 0}/${info.chunks} 个片段（${info.embedModel}）` : "没配向量接口，只按字面找") : "…"}</span>
        </div>
        <div className={row}>
          <span className="text-text-3">对话</span>
          <span className="num text-text">{info ? `${info.sessions} 段` : "…"}</span>
        </div>
        <div className={row}>
          <span className="shrink-0 text-text-3">数据库</span>
          <span className="num min-w-0 break-all text-right text-[12px] text-text-2">{info ? `${info.dbPath}（${(info.dbSizeBytes / 1048576).toFixed(1)} MB）` : "…"}</span>
        </div>
        <div className={row}>
          <span className="shrink-0 text-text-3">助手保存的文件</span>
          <span className="num min-w-0 break-all text-right text-[12px] text-text-2">{info?.saveDir ?? "…"}</span>
        </div>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-hairline px-3.5 py-3">
        <span>
          <span className="block text-[13px] text-text">重建索引</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-text-4">按原文件把所有书重新解析一遍。划线、笔记和阅读进度不受影响。搜不到明明有的内容时可以试试。</span>
        </span>
        <SecondaryButton
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNote("正在重建…");
            void api
              .resetIndex()
              .then(
                (r) => {
                  onDocsChanged();
                  setNote(r?.failed.length ? `重建了 ${r.imported} 篇；这些没成功：\n${r.failed.join("\n")}` : `重建好了（${r?.imported ?? 0} 篇）`);
                },
                (err) => setNote(String(err)),
              )
              .finally(() => {
                setBusy(false);
                load();
              });
          }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          重建
        </SecondaryButton>
      </div>
      {note && <pre className="whitespace-pre-wrap break-all rounded-md bg-bg p-3 text-[12px] text-text-3">{note}</pre>}
    </div>
  );
}

function ExtRow({ title, hint, set, onOpen }: { title: string; hint: string; set: ExtensionSet | null; onOpen: () => void }) {
  const items = set ? [...set.skills.map((n) => `技能 · ${n}`), ...set.mcp.map((n) => `MCP · ${n}`)] : [];
  return (
    <div className="rounded-xl border border-hairline px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-text">{title}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-4">{hint}</span>
        <button className="text-[12px] text-accent hover:underline" onClick={onOpen}>
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
        <div className="mt-1 text-[12px] text-text-4">还没有技能或 MCP 服务</div>
      )}
    </div>
  );
}
