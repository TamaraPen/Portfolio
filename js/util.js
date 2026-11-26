// Small helpers shared by all modules. No dependencies.

export const TOKEN_KEY = "tp_owner_token"; // sessionStorage key (cleared when the tab closes)

/**
 * Build a DOM element safely. Text is always set via textContent/text nodes,
 * never innerHTML, so content from data.json cannot inject markup.
 *   el("a", { class: "x", href: "#", onclick: fn }, "text", childNode)
 * A null/undefined/false attribute value is skipped.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

/**
 * Build an inline SVG icon with createElementNS (no innerHTML). Inline SVG is DOM, not an
 * image request, so it is unaffected by the CSP's img-src.
 *   svg("0 0 24 24", [["path", { d: "M…", fill: "#fff" }], ["circle", { cx: 5, cy: 5, r: 2 }]])
 */
const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(viewBox, shapes, cls = "icon") {
  const root = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox, class: cls, width: 24, height: 24, "aria-hidden": "true", focusable: "false" })) root.setAttribute(k, v);
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
    root.append(shape);
  }
  return root;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// --- Path helpers: "experience.1.bullets.0" ---------------------------------
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function keysOf(path) {
  const keys = path.split(".");
  if (keys.some((k) => BAD_KEYS.has(k))) throw new Error("Invalid path");
  return keys;
}
export function getPath(obj, path) {
  return keysOf(path).reduce((o, k) => (o == null ? o : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = keysOf(path);
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], obj);
  parent[last] = value;
}

// --- URL safety --------------------------------------------------------------
// Only http(s), mailto and relative paths are allowed. javascript:, data:, etc. are dropped.
export function safeUrl(raw) {
  if (!raw) return "";
  const s = String(raw).replace(/[\u0000-\u001f\u007f\s]/g, ""); // browsers ignore these inside schemes
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ""; // any other scheme
  if (s.startsWith("//")) return "";              // protocol-relative to another host
  return s;
}

// --- Files chosen in this session but not yet published ---------------------
// repoPath -> { file, url (blob: URL for previewing) }
export const pending = new Map();

/** href/src to use for a stored path: a local blob preview if not yet saved, otherwise the safe URL. */
export function resolveUrl(path) {
  return pending.has(path) ? pending.get(path).url : safeUrl(path);
}

/**
 * src for <img>/<video>/PDF <iframe>: only files on this site (relative paths) or blob: previews of
 * files chosen this session. Absolute/external URLs and any other scheme are refused ("").
 */
export function localMediaUrl(path) {
  const url = resolveUrl(path);
  if (!url) return "";
  if (url.startsWith("blob:")) return pending.has(path) ? url : "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("\\")) return "";
  return url;
}

// --- Video embeds (YouTube / Vimeo only) ---------------------------------------
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const EMBED_OK = [
  /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/,
  /^https:\/\/player\.vimeo\.com\/video\/\d{1,12}$/,
];

/** The stored embed URL, only if it is exactly an allow-listed player URL; otherwise "". */
export function safeEmbedUrl(raw) {
  const s = String(raw || "");
  return EMBED_OK.some((re) => re.test(s)) ? s : "";
}

/** Turns a pasted YouTube/Vimeo page or share link into its privacy-friendly player URL, or "". */
export function toEmbedUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let id = "";
  if (host === "youtu.be") id = parts[0] || "";
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") id = u.searchParams.get("v") || "";
    else if (["embed", "shorts", "live", "v"].includes(parts[0])) id = parts[1] || "";
  }
  if (id) return YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : "";
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const vid = (host === "player.vimeo.com" ? parts[1] : parts.find((p) => /^\d+$/.test(p))) || "";
    return /^\d{1,12}$/.test(vid) ? `https://player.vimeo.com/video/${vid}` : "";
  }
  return "";
}

// --- Misc --------------------------------------------------------------------
export function uid() {
  return "id" + Math.random().toString(36).slice(2, 10);
}

export function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

export function slugFileName(name) {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return ext ? `${base}.${ext}` : base;
}

/** Base64 of raw bytes, chunked so large files don't overflow the call stack. */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
export const textToBase64 = (text) => bytesToBase64(new TextEncoder().encode(text));
export async function fileToBase64(file) {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}
