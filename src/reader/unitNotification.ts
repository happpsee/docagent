/** 向上层报告当前段落；忽略回调的返回值，避免被 React 当成 effect 清理函数。 */
export function reportCurrentUnit(
  onUnit: (unit: number | null) => void,
  unit: number | null,
): void {
  onUnit(unit);
}
