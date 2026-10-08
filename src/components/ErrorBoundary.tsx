/** 兜底：任何一个组件在渲染时抛异常，React 会把整棵树卸载掉，界面就变成一片空白。
 *
 *  这里把它接住并把内容显示出来——既不让用户面对白屏，也让排查有据可依。
 *  之前整个应用没有错误边界，所以只要渲染里有一处抛错，看起来就像「点了书之后白屏」。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // 开着 devtools 时控制台里也留一份
    console.error("界面渲染出错：", error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const detail = [String(error.stack ?? error), info?.componentStack ?? ""].join("\n\n");
    return (
      <div className="grid h-screen place-items-center bg-bg p-8 text-text">
        <div className="w-full max-w-3xl">
          <h1 className="text-[18px] font-semibold">界面出错，这一屏没法继续渲染</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-text-3">
            把下面的内容整段复制下来发给开发者即可定位。这一条也会同时打印在控制台里。
          </p>
          <pre className="mt-3 max-h-[50vh] overflow-auto rounded-lg border border-hairline bg-nav-card p-3 text-[12px] leading-relaxed whitespace-pre-wrap">
            {detail}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] text-white"
              onClick={() => void navigator.clipboard.writeText(detail)}
            >
              复制错误
            </button>
            <button
              className="rounded-md border border-hairline px-3 py-1.5 text-[13px] text-text-2 hover:bg-nav-card"
              onClick={() => this.setState({ error: null, info: null })}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}
