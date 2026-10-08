/** 修饰键在不同平台上叫什么。
 *
 *  按键判断本身一律写成 `e.metaKey || e.ctrlKey`，两边的习惯都认；
 *  这里只管界面文案上该显示哪一个——Mac 显示 ⌘，Windows / Linux 显示 Ctrl。
 */
function detectMac(): boolean {
  if (typeof navigator === "undefined") return true;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  // 老接口在部分环境下为空，退回看 UA
  if (platform) return /mac|iphone|ipad|ipod/i.test(platform);
  return /mac os|macintosh/i.test(navigator.userAgent ?? "");
}

export const isMac = detectMac();

/** 界面文案里显示的修饰键符号 */
export const MOD = isMac ? "⌘" : "Ctrl";
