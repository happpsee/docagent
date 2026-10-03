import { useState } from "react";
import * as api from "../lib/api";
import type { Settings } from "../lib/types";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
  onError: (m: string) => void;
  onChanged: () => void;
}

export function SettingsModal({ settings, onSave, onClose, onError, onChanged }: Props) {
  const [s, setS] = useState<Settings>(settings);
  const [info, setInfo] = useState<string | null>(null);

  async function reset() {
    if (!confirm("会删掉所有文档和索引，确定？")) return;
    try {
      await api.resetIndex();
      onChanged();
      setInfo("索引已清空");
    } catch (err) {
      onError(String(err));
    }
  }

  async function showDbInfo() {
    try {
      const i = await api.dbInfo();
      setInfo(
        `${i.docs} 份文档 / ${i.chunks} 个片段 / 维度 ${i.embeddingDim ?? "未建索引"} / ` +
          `${(i.dbSizeBytes / 1024 / 1024).toFixed(1)} MB\n${i.dbPath}`,
      );
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <label>
          接口地址
          <input
            value={s.baseUrl}
            onChange={(e) => setS({ ...s, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
          <small>任何 OpenAI 兼容接口都行（DeepSeek、通义、本地 Ollama 的 /v1）</small>
        </label>

        <label>
          API Key
          <input
            type="password"
            value={s.apiKey}
            onChange={(e) => setS({ ...s, apiKey: e.target.value })}
            placeholder="留空则只能用本地模式"
          />
          <small>存在本机数据库里，不上传任何地方</small>
        </label>

        <div className="row">
          <label>
            对话模型
            <input value={s.chatModel} onChange={(e) => setS({ ...s, chatModel: e.target.value })} />
          </label>
          <label>
            向量模型
            <input value={s.embedModel} onChange={(e) => setS({ ...s, embedModel: e.target.value })} />
          </label>
        </div>

        <div className="row">
          <label>
            向量化方式
            <select
              value={s.embedMode}
              onChange={(e) => setS({ ...s, embedMode: e.target.value as Settings["embedMode"] })}
            >
              <option value="local">本地哈希（离线，质量一般）</option>
              <option value="api">调接口（需要 Key，质量好）</option>
            </select>
          </label>
          <label>
            回答方式
            <select
              value={s.answerMode}
              onChange={(e) => setS({ ...s, answerMode: e.target.value as Settings["answerMode"] })}
            >
              <option value="extract">摘录原文（不调模型）</option>
              <option value="llm">大模型生成（需要 Key）</option>
            </select>
          </label>
        </div>

        <label>
          检索片段数 {s.topK}
          <input
            type="range"
            min={3}
            max={12}
            value={s.topK}
            onChange={(e) => setS({ ...s, topK: Number(e.target.value) })}
          />
        </label>

        <p className="warn">
          换向量化方式或向量模型后，已有索引维度不匹配，需要清空重建。
        </p>

        {info && <pre className="info">{info}</pre>}

        <div className="actions">
          <button className="link" onClick={showDbInfo}>
            查看存储信息
          </button>
          <button className="link danger" onClick={reset}>
            清空索引
          </button>
          <span className="spacer" />
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              onSave(s);
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
