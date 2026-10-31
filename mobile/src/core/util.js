// Node-free utilities replacing node:crypto / node:buffer where needed.

const HEX = "0123456789abcdef";

/** 生成随机十六进制串（长度 = 2n 字符）。用 Math.random 作为轻量替代。 */
export function randomHex(bytes = 4) {
  let out = "";
  for (let i = 0; i < bytes * 2; i++) {
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

export function newId(prefix = "") {
  return `${prefix}${Date.now().toString(36)}-${randomHex(3)}`;
}

export function clip(text, limit = 1500) {
  const s = String(text ?? "");
  return s.length > limit ? s.slice(0, limit) + `\n…（共 ${s.length} 字符）` : s;
}

export function truncate(text, limit = 20000) {
  const s = String(text ?? "");
  return s.length > limit ? s.slice(0, limit) + "\n…（已截断，共 " + s.length + " 字符）" : s;
}

export function normalize(cmd) {
  return String(cmd || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sanitizeId(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "id";
}

/** 把 UTF-8 字节数组解码成字符串（不依赖 TextDecoder 的降级实现）。 */
export function utf8Decode(bytes) {
  const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
  if (decoder) return decoder.decode(bytes);
  // 简单降级：Latin1 → UTF-8 手工转
  let out = "";
  let i = 0;
  const b = bytes;
  while (i < b.length) {
    const c = b[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    } else {
      const cp =
        ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
    }
  }
  return out;
}

export function now() {
  return Date.now();
}
