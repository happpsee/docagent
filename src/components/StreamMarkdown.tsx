import { useEffect, useState, type ComponentType } from "react";

// 流式 Markdown 渲染：懒加载 streamdown，加载完成前先用保留换行的纯文本顶着。
// parseIncompleteMarkdown 让没收完的表格、代码块在流式过程中也能正常显示。

type Comp = ComponentType<Record<string, unknown>>;
let loading: Promise<Comp | null> | null = null;
let resolved: Comp | null = null;

function load(): Promise<Comp | null> {
  loading ??= import("streamdown")
    .then((mod) => {
      const m = mod as Record<string, unknown>;
      resolved = (m.Streamdown ?? m.default ?? null) as Comp | null;
      return resolved;
    })
    .catch(() => null);
  return loading;
}

export function StreamMarkdown({ content }: { content: string }) {
  const [C, setC] = useState<Comp | null>(() => resolved);

  useEffect(() => {
    if (C) return;
    let mounted = true;
    void load().then((c) => {
      if (mounted && c) setC(() => c);
    });
    return () => {
      mounted = false;
    };
  }, [C]);

  if (!C) return <div className="whitespace-pre-wrap break-words">{content}</div>;
  return (
    <C className="markdown-body text-sm leading-6" parseIncompleteMarkdown={true}>
      {content}
    </C>
  );
}
