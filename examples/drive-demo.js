/**
 * drive-demo.js — 最小驱动示例
 *
 * 用法（在云电脑已连接、画面已出流的页面控制台里执行）：
 *   1) 先跑 src/takeover.js 完成注入
 *   2) 再执行本文件，或直接把片段复制进控制台
 *
 * 效果：打开「运行」框 -> 输入 cmd -> 回车 -> 敲命令。
 */

(async function () {
  var K = window.__kbd, M = window.__mouse;
  if (!K || !M) throw new Error('请先执行 src/takeover.js');

  // 1) 鼠标移到屏幕中间点一下（让远端窗口获得焦点）
  M.abs(960, 540);
  await K.tap(27);              // esc，关掉可能存在的开始菜单
  await new Promise(function (r) { setTimeout(r, 300); });

  // 2) Win 键打开开始菜单
  await K.tap(91);
  await new Promise(function (r) { setTimeout(r, 800); });

  // 3) 输入 cmd 并回车
  await K.type('cmd', 60);
  await K.tap(13);
  await new Promise(function (r) { setTimeout(r, 1500); });

  // 4) 敲一条命令
  await K.type('whoami', 50);
  await K.tap(13);

  // 5) 组合键示例：Ctrl+A 全选
  // await K.hotkey('ctrl', 'a');
  // 6) 滚轮示例
  // M.wheel(-120);
  // 7) 右键示例
  // await M.click(2);
})();
