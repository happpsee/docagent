import { useEffect } from "react";

export function useEscapeClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 已经有人接手这次 Esc 就不再重复关闭（多层弹窗时只关最上面那层）。
      if (e.defaultPrevented) return;
      // 关掉了东西就把这次按键标记为已处理：本 hook 挂在 document 上，事件之后还会
      // 冒泡到 window——助手面板的录音快捷键就在那儿听着，不标记的话「按 Esc 关灯箱」
      // 会顺手把后台正在录的一段话一起丢掉，且没有任何提示。
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, enabled]);
}
