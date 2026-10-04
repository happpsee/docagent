import { useEffect, useId, useState } from "react";
import { Check, Database, Eye, EyeOff, Loader2, Pencil, Plus, Puzzle, Search, Sparkles, Trash2, UserRound } from "lucide-react";
import * as api from "@/lib/api";
import type { ExtensionSet, Extensions, LearnerNote, ProviderConfig, Settings } from "@/lib/types";
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

/** 目录：添加供应商时可以直接选的几家。助手用的是 Anthropic 的接口格式，所以这里都是各家「Anthropic 兼容」的地址；
 *  目录里没有的走「自定义接口」。models 是可以直接点选的型号 */
const CATALOG: { id: string; name: string; baseUrl: string; models: string[]; hint: string }[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", models: ["deepseek-flash", "deepseek-v4-pro"], hint: "在 platform.deepseek.com 申请 API Key" },
  { id: "kimi", name: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/anthropic", models: [], hint: "在 platform.moonshot.cn 申请，模型名照它控制台里的写" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", models: [], hint: "在 open.bigmodel.cn 申请，模型名照它控制台里的写" },
  { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimaxi.com/anthropic", models: [], hint: "在 platform.minimaxi.com 申请，模型名照它控制台里的写" },
  { id: "bailian", name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic", models: [], hint: "在百炼控制台申请，模型名照它控制台里的写" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api", models: [], hint: "在 openrouter.ai 申请，模型名形如 anthropic/claude-sonnet-4.5" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"], hint: "在 console.anthropic.com 申请" },
];

type Section = "model" | "profile" | "search" | "ext" | "data";
type Probe = { state: "idle" } | { state: "busy" } | { state: "ok"; text: string } | { state: "bad"; text: string };

const inputCls =
  "w-full rounded-md border border-hairline bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-accent placeholder:text-text-4";
const labelCls = "mb-1 block text-[12px] text-text-3";

/** 正在填的那张表：id 为 null 是新添加，否则是在改已有的一家 */
interface Draft extends ProviderConfig {
  id: string | null;
  tab: "catalog" | "custom";
  catalogId: string;
}

const usable = (c: ProviderConfig | undefined) => !!(c && c.apiKey.trim() && c.baseUrl.trim() && c.model.trim());
const nameOf = (id: string, c: ProviderConfig) => c.name?.trim() || CATALOG.find((p) => p.id === id)?.name || "自定义";

/** 只留真正配过的（填了 Key 的）。老设置里没有「哪一家」：按接口地址认出来，认不出就算自定义 */
function initial(settings: Settings): { active: string | null; providers: Record<string, ProviderConfig> } {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, c] of Object.entries(settings.providers ?? {})) if (c.apiKey.trim()) providers[id] = c;
  let active = settings.provider && providers[settings.provider] ? settings.provider : null;
  if (!active && settings.apiKey) {
    active = CATALOG.find((p) => p.baseUrl === settings.baseUrl.trim().replace(/\/$/, ""))?.id ?? "custom";
    providers[active] = { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model };
  }
  return { active: active ?? Object.keys(providers)[0] ?? null, providers };
}

function blank(taken: string[]): Draft {
  const first = CATALOG.find((p) => !taken.includes(p.id));
  return { id: null, tab: first ? "catalog" : "custom", catalogId: first?.id ?? "", name: "", baseUrl: first?.baseUrl ?? "", apiKey: "", model: first?.models[0] ?? "" };
}

/** 设置：左边分类，右边内容。模型这一栏按供应商一行一行列出来——哪家填了 Key、正在用哪家一眼看得到，
 *  每家各记各的，换着用不用重填；填完可以先试一下通不通再保存 */
export function SettingsModal({ settings, onSave, onClose, onDocsChanged, extensions }: Props) {
  const titleId = useId();
  const [section, setSection] = useState<Section>("model");
  const [s, setS] = useState(settings);
  const [{ active, providers }, setModels] = useState(() => initial(settings));
  const [draft, setDraft] = useState<Draft | null>(() => (Object.keys(initial(settings).providers).length ? null : blank([])));
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Record<string, Probe>>({});

  const edit = (p: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setProbe((x) => ({ ...x, form: { state: "idle" } }));
  };
  const openDraft = (d: Draft | null) => {
    setDraft(d);
    setProbe((x) => ({ ...x, form: { state: "idle" } }));
  };
  const current = active ? providers[active] : undefined;
  const clean = (c: ProviderConfig): ProviderConfig => ({
    ...(c.name?.trim() ? { name: c.name.trim() } : {}),
    baseUrl: c.baseUrl.trim().replace(/\/$/, ""),
    apiKey: c.apiKey.trim(),
    model: c.model.trim(),
  });
  const result = (): Settings => {
    const all = Object.fromEntries(Object.entries(providers).map(([id, c]) => [id, clean(c)]));
    const cur = active ? all[active] : undefined;
    return { ...s, provider: active ?? undefined, providers: all, baseUrl: cur?.baseUrl ?? "", apiKey: cur?.apiKey ?? "", model: cur?.model ?? "" };
  };
  const [pristine] = useState(() => JSON.stringify(result()));
  const dirty = JSON.stringify(result()) !== pristine;

  /** 把表里填的收进列表；第一家、或者正在用的那家还不能用时，顺手切过来 */
  function commit() {
    if (!draft) return;
    const { id, tab, catalogId, ...c } = draft;
    let key = id ?? (tab === "catalog" ? catalogId : "custom");
    for (let n = 2; !id && tab === "custom" && providers[key]; n++) key = `custom-${n}`;
    const entry = tab === "catalog" && !id ? { ...c, name: undefined } : c;
    setModels((m) => ({ active: usable(m.active ? m.providers[m.active] : undefined) ? m.active : key, providers: { ...m.providers, [key]: entry } }));
    openDraft(null);
  }

  function remove(id: string) {
    setModels((m) => {
      const { [id]: _, ...rest } = m.providers;
      return { active: m.active === id ? (Object.keys(rest)[0] ?? null) : m.active, providers: rest };
    });
    if (draft?.id === id) openDraft(null);
  }

  async function test() {
    if (!draft) return;
    setProbe((x) => ({ ...x, form: { state: "busy" } }));
    try {
      const ms = await api.testModel(draft.baseUrl.trim(), draft.apiKey.trim(), draft.model.trim());
      setProbe((x) => ({ ...x, form: { state: "ok", text: `通了，用时 ${(ms / 1000).toFixed(1)} 秒` } }));
    } catch (err) {
      setProbe((x) => ({ ...x, form: { state: "bad", text: String(err) } }));
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
    void onSave(result()).finally(() => setSaving(false));
  }

  const form = draft && (
    <ProviderForm
      draft={draft}
      taken={Object.keys(providers)}
      probe={probe.form ?? { state: "idle" }}
      onEdit={edit}
      onTest={() => void test()}
      onCancel={() => openDraft(null)}
      onDone={commit}
    />
  );

  const nav: [Section, string, typeof Sparkles][] = [
    ["model", "模型", Sparkles],
    ["profile", "我的画像", UserRound],
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
                  填入提供商的 API Key 就能用它的模型。Key 只存在这台电脑上；提问时，问题和检索到的片段会发给正在用的那一家。
                </p>
                <ul className="space-y-2">
                  {Object.entries(providers).map(([id, c]) => (
                    <li key={id} className="rounded-xl border border-hairline">
                      <div className="flex items-center gap-2 px-3.5 py-2.5">
                        <span className="min-w-0 truncate text-[13px] font-medium text-text">{nameOf(id, c)}</span>
                        <span className={`h-2 w-2 shrink-0 rounded-full ${usable(c) ? "bg-good" : "bg-track-idle"}`} title={usable(c) ? "可以用" : "还没填全"} />
                        {active === id && <span className="shrink-0 rounded-full bg-accent-dim px-1.5 py-px text-[10px] text-accent">正在用</span>}
                        <span className="num min-w-0 flex-1 truncate text-right text-[11px] text-text-4">{c.model}</span>
                        {active !== id && (
                          <SecondaryButton size="sm" disabled={!usable(c)} onClick={() => setModels((m) => ({ ...m, active: id }))}>
                            用这一家
                          </SecondaryButton>
                        )}
                        <SecondaryButton
                          size="sm"
                          onClick={() => openDraft(draft?.id === id ? null : { id, tab: CATALOG.some((p) => p.id === id) ? "catalog" : "custom", catalogId: id, name: c.name ?? "", baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model })}
                        >
                          编辑
                        </SecondaryButton>
                        <button className="shrink-0 rounded-md p-1 text-text-4 hover:bg-nav-card hover:text-danger" aria-label={`移除 ${nameOf(id, c)}`} title="移除" onClick={() => remove(id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {draft?.id === id && <div className="border-t border-hairline-soft p-3.5">{form}</div>}
                    </li>
                  ))}
                  <li>
                    {draft && draft.id === null ? (
                      <div className="rounded-xl border border-hairline-strong bg-surface-2 p-3.5">{form}</div>
                    ) : (
                      <button
                        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-hairline-strong px-3.5 py-3 text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
                        onClick={() => openDraft(blank(Object.keys(providers)))}
                      >
                        <Plus className="h-4 w-4" />
                        添加模型提供商
                      </button>
                    )}
                  </li>
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

            {section === "profile" && <ProfileSection />}
            {section === "data" && <DataSection onDocsChanged={onDocsChanged} />}
          </div>

          <div className="flex items-center gap-2 border-t border-hairline px-5 py-3">
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-4">
              {draft ? "上面那张表还没确定" : active && current && usable(current) ? `正在用：${nameOf(active, current)} · ${current.model}` : "还没有可用的模型：先添加一家"}
            </span>
            <SecondaryButton size="sm" onClick={onClose}>
              {dirty ? "取消" : "关闭"}
            </SecondaryButton>
            <PrimaryButton size="sm" disabled={saving || !!draft || !usable(current)} onClick={save}>
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

/** 添加 / 编辑一家：从目录里选（地址和常用型号是现成的），或者自己填一个 Anthropic 兼容的接口 */
function ProviderForm(p: {
  draft: Draft;
  taken: string[];
  probe: Probe;
  onEdit: (d: Partial<Draft>) => void;
  onTest: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { draft: d, onEdit } = p;
  const isNew = d.id === null;
  const entry = d.tab === "catalog" ? CATALOG.find((c) => c.id === d.catalogId) : undefined;
  const choices = CATALOG.filter((c) => !p.taken.includes(c.id));
  const tabCls = (on: boolean) => `rounded-md px-3 py-1 text-[12px] ${on ? "bg-surface text-text shadow-sm" : "text-text-3 hover:text-text"}`;
  return (
    <div className="space-y-3">
      {isNew && (
        <div className="inline-flex gap-0.5 rounded-lg bg-segment-bg p-0.5">
          <button
            className={tabCls(d.tab === "catalog")}
            disabled={!choices.length}
            onClick={() => choices[0] && onEdit({ tab: "catalog", catalogId: choices[0].id, baseUrl: choices[0].baseUrl, model: choices[0].models[0] ?? "", name: "" })}
          >
            从目录里选
          </button>
          <button className={tabCls(d.tab === "custom")} onClick={() => onEdit({ tab: "custom", baseUrl: "", model: "" })}>
            自定义接口
          </button>
        </div>
      )}
      {isNew && d.tab === "catalog" && (
        <label className="block">
          <span className={labelCls}>提供商</span>
          <select
            className={`${inputCls} h-9`}
            value={d.catalogId}
            onChange={(e) => {
              const c = CATALOG.find((x) => x.id === e.target.value);
              if (c) onEdit({ catalogId: c.id, baseUrl: c.baseUrl, model: c.models[0] ?? "" });
            }}
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {d.tab === "custom" && (
        <>
          <label className="block">
            <span className={labelCls}>名称</span>
            <input className={inputCls} value={d.name ?? ""} placeholder="随便起，方便自己认" onChange={(e) => onEdit({ name: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>接口地址</span>
            <input className={`${inputCls} num`} value={d.baseUrl} placeholder="https://…（Anthropic 兼容的地址）" onChange={(e) => onEdit({ baseUrl: e.target.value })} />
          </label>
        </>
      )}
      <div>
        <span className={labelCls}>API Key</span>
        <SecretInput value={d.apiKey} onChange={(v) => onEdit({ apiKey: v })} placeholder="sk-…" />
        {entry && <span className="mt-1 block text-[11px] text-text-4">{entry.hint}</span>}
      </div>
      <div>
        <span className={labelCls}>模型</span>
        {!!entry?.models.length && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {entry.models.map((m) => (
              <button
                key={m}
                onClick={() => onEdit({ model: m })}
                className={`num rounded-full border px-2.5 py-1 text-[12px] ${
                  d.model === m ? "border-accent bg-accent-dim text-accent" : "border-hairline text-text-2 hover:border-hairline-strong"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <input className={`${inputCls} num`} value={d.model} placeholder="模型名，照提供商控制台里的写" onChange={(e) => onEdit({ model: e.target.value })} />
      </div>
      {entry && (
        <details>
          <summary className="cursor-pointer select-none text-[12px] text-text-3 hover:text-text">自定义设置</summary>
          <span className={`${labelCls} mt-2`}>接口地址</span>
          <input className={`${inputCls} num`} value={d.baseUrl} onChange={(e) => onEdit({ baseUrl: e.target.value })} />
          {d.baseUrl !== entry.baseUrl && (
            <button className="mt-1 text-[11px] text-accent hover:underline" onClick={() => onEdit({ baseUrl: entry.baseUrl })}>
              恢复默认地址
            </button>
          )}
        </details>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <SecondaryButton size="sm" disabled={!usable(d) || p.probe.state === "busy"} onClick={p.onTest}>
          {p.probe.state === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          测试连接
        </SecondaryButton>
        <span className="min-w-0 flex-1">
          <ProbeText p={p.probe} />
        </span>
        <SecondaryButton size="sm" onClick={p.onCancel}>
          取消
        </SecondaryButton>
        <PrimaryButton size="sm" disabled={!usable(d)} onClick={p.onDone}>
          确定
        </PrimaryButton>
      </div>
    </div>
  );
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

const NOTE_KINDS: [LearnerNote["kind"], string, string][] = [
  ["background", "背景", "比如：做了 3 年前端，最近在补后端和协议"],
  ["preference", "偏好", "比如：先讲结论，再展开原理"],
  ["strength", "强项", "比如：看代码比看文字快"],
  ["weakness", "弱项", "比如：一碰到并发就容易乱"],
  ["misconception", "易错点", "比如：总以为通知也会有响应"],
];

/** 我的画像：助手每次回答前都会读一遍这里。易错点是批改时自动记下的，记得不准可以直接改，
 *  它还没注意到的也可以自己写——改过的就算你写的，之后不会被自动覆盖 */
function ProfileSection() {
  const [notes, setNotes] = useState<LearnerNote[] | null>(null);
  /** 正在写的一条：id 为 null 是新加 */
  const [draft, setDraft] = useState<{ id: number | null; kind: LearnerNote["kind"]; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void api.learnerNotes().then(setNotes, (err) => setError(String(err)));
  useEffect(load, []);
  const kindName = (k: string) => NOTE_KINDS.find((x) => x[0] === k)?.[1] ?? k;

  const save = () => {
    if (!draft?.content.trim()) return;
    void api.learnerNoteSave(draft.id, draft.kind, draft.content).then(() => {
      setDraft(null);
      load();
    }, (err) => setError(String(err)));
  };

  const editor = draft && (
    <div className="space-y-2 rounded-xl border border-hairline-strong bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1">
        {NOTE_KINDS.map(([k, name]) => (
          <button
            key={k}
            onClick={() => setDraft({ ...draft, kind: k })}
            className={`rounded-full px-2.5 py-0.5 text-[12px] ${draft.kind === k ? "bg-text text-bg" : "bg-segment-bg text-text-3 hover:text-text"}`}
          >
            {name}
          </button>
        ))}
      </div>
      <textarea
        autoFocus
        className={`${inputCls} h-16 resize-none leading-relaxed`}
        maxLength={300}
        value={draft.content}
        placeholder={NOTE_KINDS.find((x) => x[0] === draft.kind)?.[2]}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
      />
      <div className="flex justify-end gap-2">
        <SecondaryButton size="sm" onClick={() => setDraft(null)}>
          取消
        </SecondaryButton>
        <PrimaryButton size="sm" disabled={!draft.content.trim()} onClick={save}>
          保存
        </PrimaryButton>
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      <p className="pb-1 text-[12px] leading-relaxed text-text-3">
        助手每次回答前都会读一遍这里：你的背景、偏好，和答题时暴露出来的易错点。写得不准的直接改；它还没注意到的，也可以告诉它。只存在这台电脑上，提问时会随问题一起发给模型。
      </p>
      {notes?.map((n) =>
        draft?.id === n.id ? (
          <div key={n.id}>{editor}</div>
        ) : (
          <div key={n.id} className="rounded-xl border border-hairline px-3.5 py-2.5">
            <div className="flex items-start gap-2">
              <span className={`mt-px shrink-0 rounded-full px-1.5 py-px text-[10px] ${n.kind === "misconception" ? "bg-accent-dim text-accent" : "bg-segment-bg text-text-3"}`}>{kindName(n.kind)}</span>
              <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-text">{n.content}</span>
              <button className="shrink-0 rounded p-1 text-text-4 hover:bg-nav-card hover:text-text" aria-label="修改" title="修改" onClick={() => setDraft({ id: n.id, kind: n.kind, content: n.content })}>
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button className="shrink-0 rounded p-1 text-text-4 hover:bg-nav-card hover:text-danger" aria-label="删除" title="删除：助手不再记着这一条" onClick={() => void api.learnerNoteDelete(n.id).then(load, (err) => setError(String(err)))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {(n.auto || n.concept) && (
              <div className="mt-1 text-[11.5px] leading-relaxed text-text-4">
                {n.auto ? "批改时记下的" : "你写的"}
                {n.concept ? ` · 关于「${n.concept}」` : ""}
                {n.evidence ? ` · 依据：${n.evidence}` : ""}
              </div>
            )}
          </div>
        ),
      )}
      {notes && !notes.length && !draft && <p className="py-4 text-center text-[12.5px] text-text-4">助手还不太认识你。答几道题它会记下你容易错的地方，也可以现在先告诉它一些。</p>}
      {draft && draft.id === null ? (
        editor
      ) : (
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-hairline-strong px-3.5 py-2.5 text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
          onClick={() => setDraft({ id: null, kind: "background", content: "" })}
        >
          <Plus className="h-4 w-4" />
          写一条
        </button>
      )}
      {error && <p className="break-all text-[12px] text-danger">{error}</p>}
    </div>
  );
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
