import { useEffect, useState } from "react";
import { getNetLog, onNetLog, type NetEntry } from "../lib/provider";

/** 隐私面板：列出本次会话所有出站请求。本地模式下这里应该是空的。 */
export function PrivacyPanel({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<NetEntry[]>([...getNetLog()]);

  useEffect(() => onNetLog(() => setLog([...getNetLog()])), []);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>出站请求记录</h2>
        <p className="hint">
          本次会话里程序发出的全部网络请求。文档解析、分块、索引、检索都在本机完成，
          只有调用模型接口才会出网——下面列的就是全部。
        </p>

        {!log.length ? (
          <p className="empty">本次会话没有任何出站请求。</p>
        ) : (
          <table className="netlog">
            <thead>
              <tr>
                <th>时间</th>
                <th>方法</th>
                <th>地址</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {log.map((e, i) => (
                <tr key={i}>
                  <td>{new Date(e.time).toLocaleTimeString()}</td>
                  <td>{e.method}</td>
                  <td className="url">{e.url}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="actions">
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
