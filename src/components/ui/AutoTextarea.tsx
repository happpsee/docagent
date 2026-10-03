import { useRef, useEffect, useCallback } from "react";

interface AutoTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  rows?: number;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/** Auto-resizing textarea that grows with its content. */
export function AutoTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  className,
  id,
  disabled,
  rows = 2,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  return (
    <textarea
      ref={ref}
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onInput={resize}
      placeholder={placeholder}
      rows={rows}
      className={`focus-ring w-full resize-none overflow-hidden rounded-lg px-3.5 py-3 text-[13px] leading-[1.72] outline-none ${className ?? ""}`}
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-hairline-soft)",
        color: "var(--color-text)",
        fontFamily: "var(--font-sans)",
        fontWeight: 450,
        boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.45)",
      }}
    />
  );
}
