/**
 * vkmap.js — Windows 虚拟键码 (Virtual-Key Code) 表
 *
 * 云电脑 SDK 的字段名写作 charCode，实际语义是 VK 码。
 * 本表由顺网云电脑 Web 端运行时对象 (window.__kbd._MAP / _UPPER) 提取整理。
 */

// 字符 -> VK 码。大小写字母共用同一 VK（是否 Shift 由 SHIFTED 决定）。
const VK = {
  '0':48,'1':49,'2':50,'3':51,'4':52,'5':53,'6':54,'7':55,'8':56,'9':57,
  ' ':32,
  '!':49,'"':222,'#':51,'$':52,'%':53,'&':55,"'":222,'(':57,')':48,'*':56,'+':187,
  ',':188,'-':189,'.':190,'/':191,
  ':':186,';':186,'<':188,'=':187,'>':190,'?':191,'@':50,
  A:65,B:66,C:67,D:68,E:69,F:70,G:71,H:72,I:73,J:74,K:75,L:76,M:77,
  N:78,O:79,P:80,Q:81,R:82,S:83,T:84,U:85,V:86,W:87,X:88,Y:89,Z:90,
  a:65,b:66,c:67,d:68,e:69,f:70,g:71,h:72,i:73,j:74,k:75,l:76,m:77,
  n:78,o:79,p:80,q:81,r:82,s:83,t:84,u:85,v:86,w:87,x:88,y:89,z:90,
  '[':219,'\\':220,']':221,'^':54,'_':189,'\x60':192,
  '{':219,'|':220,'}':221,'~':192
};

// 需要 Shift 的字符集合（含大写字母）
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;

const SHIFT_VK = 16;

/**
 * 单个字符 -> { vk, sh }
 * vk: 虚拟键码；sh: 是否需要同时按住 Shift
 */
function vkOf(ch) {
  if (ch === undefined || ch === null) return null;
  const vk = VK[ch];
  if (vk === undefined) return null;
  const sh = SHIFTED.test(ch) || (ch >= 'A' && ch <= 'Z');
  return { vk, sh };
}

// 具名键（对齐 SDK 内部常量名的常见写法）
const NAMED = {
  enter:13, return:13, esc:27, escape:27, space:32, tab:9,
  backspace:8, delete:46, del:46, insert:45, ins:45,
  home:36, end:35, pageup:33, pgup:33, pagedown:34, pgdn:34,
  up:38, arrowup:38, down:40, arrowdown:40, left:37, arrowleft:37, right:39, arrowright:39,
  shift:16, shiftleft:16, shiftright:16,
  ctrl:17, control:17, ctrlleft:17, ctrlright:17,
  alt:18, altleft:18, altright:18,
  win:91, lwin:91, meta:91, cmd:91,
  capslock:20, numlock:144, scrolllock:145,
  f1:112, f2:113, f3:114, f4:115, f5:116, f6:117, f7:118, f8:119, f9:120, f10:121, f11:122, f12:123,
  printscreen:44, pause:19
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VK, SHIFTED, SHIFT_VK, NAMED, vkOf };
}
if (typeof window !== 'undefined') {
  window.VKMAP = { VK, SHIFTED, SHIFT_VK, NAMED, vkOf };
}
