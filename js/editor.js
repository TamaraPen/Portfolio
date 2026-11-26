// Owner editing mode.
//
// IMPORTANT: this file is loaded with a dynamic import() only AFTER a GitHub token has been
// verified, so none of these controls exist in the page for ordinary visitors. Even if someone
// loaded this file by hand, saving would fail: GitHub rejects writes without the owner's token.

import { CONFIG } from "../config.js";
import { state } from "./state.js";
import { renderAll } from "./render.js";
import { setIndex } from "./viewer.js";
import { el, getPath, setPath, uid, safeUrl, toEmbedUrl, localMediaUrl, pending, slugFileName, fileToBase64, textToBase64 } from "./util.js";
import { openDialog, confirmDialog, choiceDialog, toast } from "./dialog.js";
import { fetchRemoteData, commitFiles } from "./github.js";
import { signOut } from "./auth.js";

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"]; // SVG deliberately excluded (can contain scripts)
const VIDEO_EXT = ["mp4", "webm"];
const DOC_EXT = ["pdf", "docx", "pptx", "xlsx", "csv", "txt", "md", "json", "zip"];
const ANY_EXT = [...IMAGE_EXT, ...VIDEO_EXT, ...DOC_EXT];   // attached files / links
const MEDIA_EXT = [...IMAGE_EXT, ...VIDEO_EXT, "pdf"];      // things the media viewer can show
const accept = (exts) => exts.map((e) => "." + e).join(",");
const LIMITS = CONFIG.uploadLimitsMB;
const MB = 1024 * 1024;
const PPTX_MSG = "PowerPoint files can't be shown in a web page. In PowerPoint use File → Export → PDF (or export the slides as images), then add the PDF, or select all the slide images together to make a slide deck.";

// Plain-text-only editing where supported (Chrome, Safari, recent Firefox); paste is sanitised anyway.
const PLAIN_TEXT = (() => { const d = document.createElement("div"); d.contentEditable = "plaintext-only"; return d.contentEditable === "plaintext-only"; })();

let token = null;
let editing = false;
let dirty = false;
let saving = false;
let exiting = false;
let savedJson = "";       // content as last loaded/saved, for "Discard and exit"
const committed = new Set(); // uploaded paths already saved this session
const ui = {};

// ---------------------------------------------------------------------------
/**
 * Starts owner mode. Returns { toggle } for the top-bar button (#owner-login, wired in main.js):
 * in edit mode it is the red EXIT pill; outside edit mode it is the pencil that re-enters it.
 * Edit mode starts ON, so everything is editable straight away. The owner stays signed in for
 * this tab after exiting edit mode; "Log out" (in the edit-mode bar) ends the session.
 */
export async function startEditor({ token: verifiedToken, remote }) {
  token = verifiedToken;
  ui.fab = document.getElementById("owner-login");
  ui.fab.classList.add("is-owner");
  ui.fab.append(el("span", { class: "edit-fab__label", "aria-hidden": "true" }, "EXIT"));

  // Edit from the newest saved copy on GitHub, not the Pages copy (which can lag a few minutes).
  try {
    // `remote` is the fetch main.js started in parallel; fall back to fetching it here
    const latest = remote ? await remote : await fetchRemoteData(token, CONFIG.github, CONFIG.dataPath);
    if (latest?.error) throw latest.error;
    if (JSON.stringify(latest) !== JSON.stringify(state.data)) {
      state.data = latest;
      renderAll(state.data);
      toast("Loaded the latest saved version from GitHub.");
    }
  } catch {
    toast("Could not confirm the latest saved version on GitHub. Saving would overwrite any newer changes there.", "error");
  }
  savedJson = JSON.stringify(state.data);

  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  setEditing(true);
  return { toggle: () => (editing ? requestExit() : setEditing(true)) };
}

// --- Edit-mode bar: exists only while edit mode is on ------------------------
function buildToolbar() {
  if (ui.bar) return;
  ui.save = el("button", { type: "button", class: "btn", disabled: dirty && !saving ? null : "", onclick: doSave }, "Save changes");
  ui.exportBtn = el("button", { type: "button", class: "btn btn--ghost", onclick: exportJson }, "Export JSON");
  ui.logout = el("button", { type: "button", class: "btn btn--ghost", onclick: logout }, "Log out");
  ui.status = el("span", { class: "ownerbar__status", role: "status", "aria-live": "polite" }, dirty ? "Unsaved changes" : "Editing · signed in as owner");
  ui.status.classList.toggle("is-dirty", dirty);
  ui.bar = el("div", { class: "ownerbar", role: "region", "aria-label": "Owner tools" }, ui.save, ui.exportBtn, ui.logout, ui.status);
  document.body.append(ui.bar);
  document.body.classList.add("has-ownerbar");
}

function removeToolbar() {
  ui.bar?.remove();
  ui.bar = ui.save = ui.exportBtn = ui.logout = ui.status = null;
  document.body.classList.remove("has-ownerbar");
}

function setStatus(text, isDirty = false) {
  if (!ui.status) return;
  ui.status.textContent = text;
  ui.status.classList.toggle("is-dirty", isDirty);
}

function markDirty() {
  dirty = true;
  if (ui.save && !saving) ui.save.disabled = false;
  setStatus("Unsaved changes", true);
}

function setEditing(on) {
  editing = on;
  document.body.classList.toggle("editing", on);
  if (on) buildToolbar(); else removeToolbar();
  ui.fab.classList.toggle("is-exit", on);
  ui.fab.setAttribute("aria-pressed", String(on));
  ui.fab.setAttribute("aria-label", on ? "Exit edit mode" : "Edit page");
  ui.fab.dataset.tooltip = on ? "exit edit mode" : "edit page";
  rerender();
}

/** EXIT: leave edit mode, asking first if there are unsaved changes. */
async function requestExit() {
  if (exiting || saving) return;
  if (!dirty) { setEditing(false); return; }
  exiting = true;
  try {
    const choice = await choiceDialog({
      title: "You have unsaved changes",
      intro: "Save them to GitHub before leaving edit mode?",
      choices: [
        { label: "Save and exit", value: "save", kind: "primary" },
        { label: "Discard and exit", value: "discard", kind: "danger" },
        { label: "Cancel", value: null, kind: "ghost" },
      ],
    });
    if (choice === "save") {
      if (await doSave()) setEditing(false);
    } else if (choice === "discard") {
      state.data = JSON.parse(savedJson);
      dirty = false;
      setEditing(false);
      toast("Changes discarded.");
    }
  } finally {
    exiting = false;
  }
}

function rerender() {
  const y = window.scrollY;
  renderAll(state.data);
  if (editing) decorate();
  window.scrollTo({ top: y, behavior: "instant" });
}

/** A structural change (add/remove/replace): mark dirty and redraw. */
function changed() {
  markDirty();
  rerender();
}

// --- Save / export / logout -------------------------------------------------
/** Commits data.json plus any new uploads in ONE commit. Resolves true when saved. */
async function doSave() {
  if (saving) return false;
  if (!dirty) return true;
  saving = true;
  if (ui.save) ui.save.disabled = true;
  setStatus("Saving…");
  try {
    const json = JSON.stringify(state.data, null, 2) + "\n";
    const files = [];
    for (const [path, { file }] of pending) {
      if (json.includes(path) && !committed.has(path)) files.push({ path, base64: await fileToBase64(file) });
    }
    files.push({ path: CONFIG.dataPath, base64: textToBase64(json) });
    await commitFiles(token, CONFIG.github, files, "Update portfolio content (owner editor)");
    files.forEach((f) => committed.add(f.path));
    dirty = false;
    savedJson = JSON.stringify(state.data);
    setStatus("Saved");
    toast("Saved to GitHub. Visitors will see the update once GitHub Pages finishes publishing (usually within a few minutes).");
    return true;
  } catch (e) {
    if (ui.save) ui.save.disabled = false;
    setStatus("Save failed", true);
    toast(e.message || "Save failed.", "error");
    return false;
  } finally {
    saving = false;
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `portfolio-data-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function logout() {
  if (dirty && !(await confirmDialog("You have unsaved changes. Log out and discard them?", "Log out"))) return;
  dirty = false;
  signOut();
  location.reload();
}

// --- Files -----------------------------------------------------------------
const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
function categoryOf(ext) {
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  return "other";
}

/** Validates a chosen file against `allowed` and the size caps, and queues it for the next save. */
function registerFile(file, allowed) {
  const ext = extOf(file.name);
  if (ext === "pptx" && !allowed.includes("pptx")) throw new Error(PPTX_MSG);
  if (!allowed.includes(ext)) throw new Error(`.${ext || "?"} files are not allowed here. Allowed: ${allowed.join(", ")}`);
  const cat = categoryOf(ext);
  const cap = LIMITS[cat] ?? LIMITS.other;
  if (file.size > cap * MB) {
    throw new Error(cat === "video"
      ? `"${file.name}" is larger than ${cap} MB. For longer videos, upload them to YouTube as "Unlisted" and paste the link here instead.`
      : `"${file.name}" is larger than ${cap} MB, the limit for ${cat === "other" ? "documents" : `${cat === "pdf" ? "PDF" : cat}s`}.`);
  }
  const path = `${CONFIG.uploadDir}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${slugFileName(file.name)}`;
  pending.set(path, { file, url: URL.createObjectURL(file) });
  return path;
}

const FILE_HELP = `Up to ${LIMITS.image} MB per image, ${LIMITS.pdf} MB per PDF, ${LIMITS.video} MB per video and ${LIMITS.other} MB for other documents. Files are public once saved to a public repository.`;

// --- Decorating the rendered page with edit controls ------------------------
// Brand (header) and footer text are editable too, so decorate all three page regions.
// Everything added here is removed again on EXIT, because leaving edit mode re-renders the page
// without decorating it.
const ROOTS = "#top, main, footer";

function decorate() {
  const all = (sel) => document.querySelectorAll(ROOTS.split(", ").map((r) => `${r} ${sel}`).join(", "));
  // Dropdown rows keep their normal open/closed behaviour (all start closed). Clicking an editable
  // title or an editor control inside a row header must not toggle the row.
  all("summary").forEach((s) => s.addEventListener("click", (e) => {
    if (e.target.closest("[contenteditable], [data-editor-ui], .ed-btn")) e.preventDefault();
  }));
  all("[data-edit]").forEach(makeEditable);
  // While editing, links (nav, buttons, brand, social icons, files) must not navigate away.
  all("a").forEach((a) => a.addEventListener("click", (e) => e.preventDefault()));
  const main = document.querySelector("main");
  main.querySelectorAll("[data-img]").forEach(decorateImage);
  main.querySelectorAll("[data-viewer]").forEach(decorateViewer);
  main.querySelectorAll("[data-tags]").forEach(decorateTags);
  main.querySelectorAll("[data-doclinks]").forEach(decorateDocLinks);
  main.querySelectorAll("[data-url]").forEach(decorateUrl);
  [main, ...main.querySelectorAll("[data-collection]")].forEach(decorateCollection);
  main.querySelectorAll("[data-badge]").forEach(decorateBadge);
}

const button = (label, onclick, extra = "") => el("button", { type: "button", class: `ed-btn ${extra}`.trim(), onclick }, label);

function makeEditable(node) {
  const path = node.dataset.edit;
  const multi = "multiline" in node.dataset;
  node.setAttribute("contenteditable", PLAIN_TEXT ? "plaintext-only" : "true");
  node.setAttribute("spellcheck", "true");
  node.setAttribute("role", "textbox");
  node.classList.add("is-editable");
  node.addEventListener("input", () => {
    const text = multi ? node.innerText.replace(/\n+$/, "") : node.textContent;
    setPath(state.data, path, text);
    markDirty();
  });
  node.addEventListener("keydown", (e) => {
    if (!multi && e.key === "Enter") { e.preventDefault(); node.blur(); }
    // Space/Enter inside an editable row title must type, not toggle the dropdown row
    if (e.key === " " && node.closest("summary")) { e.preventDefault(); document.execCommand("insertText", false, " "); }
  });
  node.addEventListener("paste", (e) => {
    e.preventDefault();
    let text = (e.clipboardData || window.clipboardData).getData("text/plain");
    if (!multi) text = text.replace(/\s*\n+\s*/g, " ");
    document.execCommand("insertText", false, text);
  });
}

// Profile photo
function decorateImage(node) {
  const path = node.dataset.img;
  const has = Boolean(getPath(state.data, path));
  const controls = el("span", { class: "ed-inline ed-reveal", "data-editor-ui": "" },
    button(has ? "Replace photo" : "Add photo", () => chooseImage(path)),
    has ? button("Remove", () => { setPath(state.data, path, ""); changed(); }, "ed-btn--danger") : null);
  node.after(controls);
  if (!has) {
    // editable "No image" label (ui.noImage) next to the empty photo slot
    const none = el("span", { class: "muted ed-noimage", "data-edit": "ui.noImage" }, state.data.ui.noImage);
    controls.prepend(none);
    makeEditable(none);
  }
  // Alt text (read by screen readers) for an image that is present
  const altPath = node.dataset.alt;
  if (has && altPath) {
    const value = el("span", { class: "ed-alt__value", "data-edit": altPath }, getPath(state.data, altPath) || "");
    controls.after(el("span", { class: "ed-alt ed-reveal", "data-editor-ui": "" }, "Alt text: ", value));
    makeEditable(value);
    value.addEventListener("input", () => { const img = node.querySelector("img"); if (img) img.alt = value.textContent; });
  }
}

async function chooseImage(path) {
  const ok = await openDialog({
    title: "Choose an image",
    intro: "PNG, JPG, WebP or GIF.",
    fields: [{ name: "file", label: "Image file", type: "file", accept: accept(IMAGE_EXT), help: FILE_HELP }],
    confirmLabel: "Use image",
    onSubmit: ({ file }) => {
      if (!file) throw new Error("Choose a file first.");
      setPath(state.data, path, registerFile(file, IMAGE_EXT));
      return true;
    },
  });
  if (ok) changed();
}

// Tag lists (skills)
function decorateTags(ul) {
  const path = ul.dataset.tags;
  ul.querySelectorAll(":scope > li").forEach((li, i) => {
    li.append(button("✕", () => { getPath(state.data, path).splice(i, 1); changed(); }, "ed-btn--danger ed-x ed-x--inline"));
    li.lastChild.setAttribute("aria-label", `Remove ${li.textContent.replace("✕", "").trim()}`);
  });
  ul.append(el("li", { class: "ed-reveal" }, button("+ Add tag", async () => {
    const ok = await openDialog({
      title: "Add a tag",
      fields: [{ name: "text", label: "Tag text" }],
      confirmLabel: "Add",
      onSubmit: ({ text }) => {
        if (!text) throw new Error("Enter some text.");
        getPath(state.data, path).push(text);
        return true;
      },
    });
    if (ok) changed();
  })));
}

// A project's "View full documents" row: always visible in edit mode, with an Add document control.
function decorateDocLinks(ul) {
  const path = ul.dataset.doclinks;
  ul.closest("details").hidden = false;
  ul.querySelectorAll(":scope > li").forEach((li, i) => {
    const b = button("✕", () => { getPath(state.data, path).splice(i, 1); changed(); }, "ed-btn--danger ed-x");
    b.setAttribute("aria-label", "Remove document");
    li.classList.add("ed-box");
    li.append(b);
  });
  ul.after(el("button", { type: "button", class: "btn btn--ghost ed-add ed-add--mini ed-reveal", onclick: () => addDocument(path) }, "Add document"));
}

async function addDocument(path) {
  const ok = await openDialog({
    title: "Add a document",
    intro: "PDFs and images open in the full-screen viewer; other files download.",
    fields: [
      { name: "label", label: "Document name" },
      { name: "file", label: "Upload a file", type: "file", accept: accept(ANY_EXT), help: FILE_HELP },
      { name: "url", label: "Or a web address", help: "https://…" },
    ],
    confirmLabel: "Add",
    onSubmit: ({ label, url, file }) => {
      if (!label) throw new Error("Enter the document name.");
      let value;
      if (file) value = registerFile(file, ANY_EXT);
      else {
        value = safeUrl(url);
        if (!value) throw new Error("Choose a file, or enter a valid https:// address.");
      }
      getPath(state.data, path).push({ label, url: value });
      return true;
    },
  });
  if (ok) changed();
}

// Edit the URL / uploaded file behind any [data-url] element (documents, links, icon buttons)
function decorateUrl(node) {
  const path = node.dataset.url;
  if (node.dataset.urlKind === "email") return decorateEmail(node, path);
  const btn = button("Edit link", async () => {
    const current = getPath(state.data, path) || "";
    const ok = await openDialog({
      title: "Edit link or file",
      fields: [
        { name: "url", label: "Web address", value: pending.has(current) ? "" : current, help: "https://… Leave empty to clear it." },
        { name: "file", label: "Or upload a file", type: "file", accept: accept(ANY_EXT), help: FILE_HELP },
      ],
      confirmLabel: "Update",
      onSubmit: ({ url, file }) => {
        if (file) setPath(state.data, path, registerFile(file, ANY_EXT));
        else {
          const safe = safeUrl(url);
          if (url && !safe) throw new Error("That address is not allowed. Use https://, mailto: or a file.");
          setPath(state.data, path, safe);
        }
        return true;
      },
    });
    if (ok) changed();
  });
  btn.classList.add("ed-inline", "ed-reveal");
  node.after(btn);
}

// The email icon stores a bare address; the page builds the mailto: link.
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
function decorateEmail(node, path) {
  const btn = button("Edit email", async () => {
    const ok = await openDialog({
      title: "Edit email address",
      fields: [{ name: "email", label: "Email address", value: getPath(state.data, path) || "" }],
      confirmLabel: "Update",
      onSubmit: ({ email }) => {
        if (email && !EMAIL_RE.test(email)) throw new Error("Enter a valid email address, e.g. name@example.com.");
        setPath(state.data, path, email);
        return true;
      },
    });
    if (ok) changed();
  });
  btn.classList.add("ed-inline", "ed-reveal");
  node.after(btn);
}

// --- Templates and "add" dialogs -----------------------------------------------------
const entryTemplate = () => ({ role: "New role", org: "Organisation", place: "Place", dates: "Dates", summary: "", bullets: ["New bullet point"] });
const projectButtons = () => [{ kind: "github", url: "" }, { kind: "live", url: "" }, { kind: "document", url: "" }];
const TEMPLATES = {
  documents: () => ({ id: uid(), kind: "PDF", title: "New document", note: "Short description.", url: "", placeholder: "" }),
  entry: entryTemplate,
  skills: () => ({ group: "New skill group", items: [] }),
  bullet: () => "New bullet point",
  accordion: () => ({ title: "New row", body: "" }),
};

const BLOCK_CHOICES = [
  ["text", "Text"],
  ["project", "Project (title, media viewer, dropdown rows)"],
  ["gallery", "Gallery (media only)"],
  ["entries", "Entry list (title, dates, bullets — like Experience)"],
  ["tags", "Tag list (like Skills)"],
  ["buttons", "Row of round icon buttons"],
  ["documents", "Documents list"],
];
function newBlock(type) {
  const id = uid();
  switch (type) {
    case "text": return { id, type, title: "New heading", body: "Write something here." };
    case "project": return { id, type, title: "New project", media: [], documents: [], buttons: projectButtons(),
      accordions: [{ title: "Overview", body: "" }, { title: "Tools used / how it was built", body: "" }, { title: "What I learned", body: "" }] };
    case "gallery": return { id, type, title: "", media: [] };
    case "entries": return { id, type, title: "", addLabel: "Add entry", items: [entryTemplate()] };
    case "tags": return { id, type, title: "", groups: [{ group: "New group", items: ["New tag"] }] };
    case "buttons": return { id, type, buttons: [{ kind: "live", url: "" }] };
    case "documents": return { id, type, title: "Documents", items: [] };
    default: throw new Error("Unknown block type");
  }
}
const BLOCK_LABEL = { text: "Text", project: "Project", gallery: "Gallery", entries: "Entry list", tags: "Tag list", buttons: "Icon buttons", documents: "Documents list", contact: "Contact details" };
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "section";

// Adders open a dialog first; they return true when something was added.
const ADDERS = {
  async section(path) {
    return openDialog({
      title: "Add section",
      intro: "A new panel at the end of the page. It appears in the navigation under its title; drag it to move it.",
      fields: [
        { name: "title", label: "Section title" },
        { name: "type", label: "Start with", type: "select", options: BLOCK_CHOICES },
      ],
      confirmLabel: "Add section",
      onSubmit: ({ title, type }) => {
        if (!title) throw new Error("Enter a title for the section.");
        const list = getPath(state.data, path);
        let id = slugify(title);
        if (id === "overview" || id === "main" || id === "top" || list.some((s) => s.id === id)) id = `${id}-${uid().slice(2, 6)}`;
        list.push({ id, title, navLabel: "", blocks: [newBlock(type)] });
        return true;
      },
    });
  },
  async block(path) {
    return openDialog({
      title: "Add block",
      fields: [{ name: "type", label: "Block type", type: "select", options: BLOCK_CHOICES }],
      confirmLabel: "Add block",
      onSubmit: ({ type }) => { getPath(state.data, path).push(newBlock(type)); return true; },
    });
  },
  async button(path) {
    return openDialog({
      title: "Add icon button",
      fields: [
        { name: "kind", label: "Icon", type: "select", options: [["live", "Website / live link"], ["github", "GitHub"], ["linkedin", "LinkedIn"], ["document", "Document"], ["cv", "CV"], ["email", "Email"]] },
        { name: "url", label: "Link (or email address)", help: "You can also upload a file later with Edit link." },
      ],
      confirmLabel: "Add",
      onSubmit: ({ kind, url }) => {
        let value = "";
        if (kind === "email") {
          if (url && !EMAIL_RE.test(url)) throw new Error("Enter a valid email address.");
          value = url;
        } else if (url) {
          value = safeUrl(url);
          if (!value) throw new Error("That address is not allowed. Use https:// or mailto:.");
        }
        getPath(state.data, path).push({ kind, url: value });
        return true;
      },
    });
  },
};

function itemName(value) {
  if (typeof value === "string") return value.length > 50 ? `${value.slice(0, 50)}…` : value;
  if (value?.type && !value.title && !value.label) return `this ${value.type === "entries" ? "entry list" : value.type} block`;
  return value?.title || value?.label || value?.role || value?.group || "this item";
}

// --- Reordering: drag handles (Pointer Events: mouse, pen and touch) + up/down buttons ---------
function moveItem(path, from, to) {
  if (from === to) return;
  const list = getPath(state.data, path);
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  if (/\.media$/.test(path)) setIndex(path, slideIndexOf(list, to));
  changed();
}

function startDrag(e, item, container, path, axis) {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  const items = [...container.querySelectorAll(":scope > [data-item]")];
  const from = items.indexOf(item);
  const others = items.filter((x) => x !== item);
  const scroller = axis === "x" ? container : null;   // the media strip scrolls sideways
  const line = el("div", { class: `ed-drop-line ed-drop-line--${axis}`, "data-editor-ui": "", "aria-hidden": "true" });
  document.body.append(line);
  item.classList.add("is-dragging");
  document.body.classList.add("is-reordering");
  let to = from;
  let last = { x: e.clientX, y: e.clientY };
  let raf = 0;

  const place = () => {
    const p = axis === "x" ? last.x : last.y;
    const rects = others.map((o) => o.getBoundingClientRect());
    to = rects.filter((r) => (axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2) < p).length;
    const cr = container.getBoundingClientRect();
    let at;
    if (!rects.length) { const r = item.getBoundingClientRect(); at = axis === "x" ? r.left : r.top; }
    else if (to < rects.length) at = (axis === "x" ? rects[to].left : rects[to].top) - 5;
    else at = (axis === "x" ? rects[rects.length - 1].right : rects[rects.length - 1].bottom) + 3;
    // Positioning via the CSSOM (not style attributes), which the CSP allows
    if (axis === "x") Object.assign(line.style, { left: `${at}px`, top: `${cr.top}px`, height: `${cr.height}px` });
    else Object.assign(line.style, { top: `${at}px`, left: `${cr.left}px`, width: `${cr.width}px` });
  };
  // Auto-scroll while the pointer is near the edge of the window (or of the media strip)
  const tick = () => {
    const edge = 70;
    let dy = 0;
    if (last.y < edge) dy = -Math.ceil((edge - last.y) / 3);
    else if (last.y > innerHeight - edge) dy = Math.ceil((last.y - (innerHeight - edge)) / 3);
    if (dy) window.scrollBy(0, dy);
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (last.x < r.left + 40) scroller.scrollLeft -= 8;
      else if (last.x > r.right - 40) scroller.scrollLeft += 8;
    }
    place();
    raf = requestAnimationFrame(tick);
  };
  const end = (drop) => {
    cancelAnimationFrame(raf);
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onCancel);
    line.remove();
    item.classList.remove("is-dragging");
    document.body.classList.remove("is-reordering");
    if (drop) moveItem(path, from, to);
  };
  const onMove = (ev) => { last = { x: ev.clientX, y: ev.clientY }; place(); };
  const onUp = () => end(true);
  const onCancel = () => end(false);
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onCancel);
  place();
  raf = requestAnimationFrame(tick);
}

function sortControls(item, container, path, index, count, axis) {
  const prevLabel = axis === "x" ? "Move earlier" : "Move up";
  const nextLabel = axis === "x" ? "Move later" : "Move down";
  const grip = button("⠿", null, "ed-grip");
  grip.setAttribute("aria-label", "Drag to move (or use the arrow buttons)");
  grip.title = "Drag to move";
  grip.addEventListener("pointerdown", (e) => startDrag(e, item, container, path, axis));
  // Keyboard: arrow keys on a focused grip move the item (the ↑/↓ buttons also appear on focus)
  grip.addEventListener("keydown", (e) => {
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key === back && index > 0) { e.preventDefault(); moveItem(path, index, index - 1); }
    if (e.key === fwd && index < count - 1) { e.preventDefault(); moveItem(path, index, index + 1); }
  });
  const up = button(axis === "x" ? "←" : "↑", () => moveItem(path, index, index - 1), "ed-move");
  const down = button(axis === "x" ? "→" : "↓", () => moveItem(path, index, index + 1), "ed-move");
  up.setAttribute("aria-label", prevLabel);
  down.setAttribute("aria-label", nextLabel);
  if (index === 0) up.disabled = true;
  if (index === count - 1) down.disabled = true;
  return el("span", { class: "ed-sort", "data-editor-ui": "" }, grip, up, down);
}

function decorateCollection(container) {
  const path = container.dataset.collection;
  if (!path) return;
  const tpl = container.dataset.template || path;
  const adder = ADDERS[tpl];
  const template = TEMPLATES[tpl];
  const axis = container.dataset.sortable;
  const items = [...container.querySelectorAll(":scope > [data-item]")];
  items.forEach((item, index) => {
    const value = getPath(state.data, item.dataset.item);
    const small = typeof value === "string"; // bullet points: inline ✕, no confirmation
    const removeNow = async () => {
      if (!small && !(await confirmDialog(`Remove ${tpl === "section" ? "the section " : ""}"${itemName(value)}"? The change is applied when you press Save.`, "Remove"))) return;
      getPath(state.data, path).splice(index, 1);
      changed();
    };
    const remove = button("✕", removeNow, "ed-btn--danger ed-remove ed-x");
    remove.setAttribute("aria-label", `Remove ${itemName(value)}`);
    remove.title = "Remove";
    item.classList.add("ed-box");
    if (tpl === "section" || tpl === "block") {
      // Sections and blocks: one labelled header bar, grip on the left, ✕ on the right
      remove.classList.add("ed-x--bar");
      const label = tpl === "section" ? "Section" : BLOCK_LABEL[value.type] || "Block";
      item.prepend(el("div", { class: "ed-bar", "data-editor-ui": "" },
        sortControls(item, container, path, index, items.length, axis),
        el("span", { class: "ed-bar__label" }, label),
        remove));
      return;
    }
    // Everything else: a small ✕ on the box's top-right corner (shown on hover / focus)
    item.append(remove);
    if (axis) {
      const controls = sortControls(item, container, path, index, items.length, axis);
      const summary = item.matches("details") ? item.querySelector(":scope > summary") : null;
      if (summary) summary.prepend(controls);
      else { controls.classList.add("ed-sort--corner"); item.prepend(controls); }
    }
  });
  if ("noAdd" in container.dataset || (!adder && !template)) return;
  const major = tpl === "section" || tpl === "block";
  const add = el("button", {
    type: "button",
    class: `btn btn--ghost ed-add${tpl === "section" ? " ed-add--section" : ""}${major ? " ed-add--major" : " ed-add--mini ed-reveal"}`,
    onclick: async () => {
      if (adder) { if (await adder(path)) changed(); }
      else { getPath(state.data, path).push(template()); changed(); }
    },
  }, `+ ${container.dataset.addLabel || "Add"}`);
  if ("addInside" in container.dataset) container.append(add); else container.after(add);
}

// "Placeholder" badges can be dismissed once the real content is in
function decorateBadge(node) {
  const path = node.dataset.badge;
  node.after(el("span", { class: "ed-inline ed-reveal", "data-editor-ui": "" }, button("Dismiss tag", () => { setPath(state.data, path, ""); changed(); })));
}

// --- Media (viewer) ------------------------------------------------------------------
/** Index of the first viewer slide for media item `item` (slide decks take one slide per image). */
function slideIndexOf(list, item, slideInDeck = 0) {
  let n = 0;
  for (let k = 0; k < item; k++) n += list[k].type === "slides" ? (list[k].slides || []).length : 1;
  return n + slideInDeck;
}

function editableField(labelText, path) {
  const value = el("span", { class: "ed-alt__value", "data-edit": path }, getPath(state.data, path) || "");
  makeEditable(value);
  return el("span", { class: "ed-alt ed-reveal", "data-editor-ui": "" }, labelText, value);
}

const MEDIA_LABEL = { image: "Image", slides: "Slides", video: "Video", pdf: "PDF", embed: "Video link" };
function thumb(m) {
  const src = m.type === "image" ? m.src : m.type === "slides" ? m.slides?.[0]?.src : m.type === "video" ? m.poster : "";
  const url = src ? localMediaUrl(src) : "";
  return url ? el("img", { class: "ed-thumb__img", src: url, alt: "" }) : el("span", { class: "ed-thumb__icon" }, m.type === "pdf" ? "PDF" : "▶");
}

function decorateViewer(viewer) {
  const path = viewer.dataset.media;
  const list = getPath(state.data, path);
  viewer.hidden = false;

  // Per-slide extras: alt text, slide-deck order, video poster
  viewer.querySelectorAll(".viewer__slide").forEach((slideEl) => {
    const itemPath = slideEl.dataset.itemPath;
    const i = Number(itemPath.split(".").pop());
    const item = list[i];
    const deckPath = slideEl.dataset.slidePath;            // only for slide-deck images
    const j = deckPath ? Number(deckPath.split(".").pop()) : 0;
    const bar = el("div", { class: "ed-media ed-reveal", "data-editor-ui": "" });
    if (deckPath) {
      const slides = item.slides;
      const moveSlide = (to) => {
        const [s] = slides.splice(j, 1);
        slides.splice(to, 0, s);
        setIndex(path, slideIndexOf(list, i, to));
        changed();
      };
      bar.append(el("span", { class: "ed-media__group" },
        j > 0 ? button("◀ Slide earlier", () => moveSlide(j - 1)) : null,
        j < slides.length - 1 ? button("Slide later ▶", () => moveSlide(j + 1)) : null,
        button("Remove slide", () => {
          slides.splice(j, 1);
          if (!slides.length) list.splice(i, 1);
          setIndex(path, Math.max(0, slideIndexOf(list, Math.min(i, list.length - 1), Math.max(0, j - 1))));
          changed();
        }, "ed-btn--danger"),
        button("+ Add slides", () => addSlides(path, i))));
    }
    if (item.type === "video") bar.append(button(item.poster ? "Replace poster" : "Add poster image", () => chooseImage(`${itemPath}.poster`)));
    const altPath = deckPath ? `${deckPath}.alt` : `${itemPath}.alt`;
    const altLabel = item.type === "image" || deckPath ? "Alt text: " : "Description (for screen readers): ";
    slideEl.querySelector(".viewer__frame").after(...(bar.childElementCount ? [bar] : []), editableField(altLabel, altPath));
  });

  // Media strip: every item as a thumbnail, draggable (or ← → buttons) to reorder, ✕ to delete
  if (list.length) {
    viewer.append(el("div", { class: "ed-tray", "data-editor-ui": "", "data-collection": path, "data-sortable": "x", "data-template": "media", "data-no-add": "" },
      list.map((m, k) => el("div", { class: "ed-thumb", "data-item": `${path}.${k}` },
        thumb(m), el("span", { class: "ed-thumb__label" }, `${k + 1}. ${MEDIA_LABEL[m.type] || m.type}`)))));
  }
  viewer.append(el("button", { type: "button", class: "btn btn--ghost ed-add", onclick: () => addMedia(path) }, "Add media"));
}

async function addMedia(path) {
  const list = getPath(state.data, path);
  const ok = await openDialog({
    title: "Add media",
    intro: "Images, a slide deck (select several images at once), a video, a PDF, or a YouTube/Vimeo link.",
    fields: [
      { name: "files", label: "Upload file(s)", type: "file", multiple: true, accept: accept([...MEDIA_EXT, "pptx"]), help: `${FILE_HELP} Longer videos: upload to YouTube as "Unlisted" and paste the link below.` },
      { name: "url", label: "Or paste a YouTube or Vimeo link", help: "e.g. https://www.youtube.com/watch?v=… or https://vimeo.com/…" },
      { name: "caption", label: "Caption (optional)" },
    ],
    confirmLabel: "Add",
    onSubmit: ({ files, url, caption }) => {
      if (files.length && url) throw new Error("Choose files or paste a link, not both.");
      const base = { alt: "", caption: caption || "", poster: "" };
      let item;
      if (files.length) {
        if (files.some((f) => extOf(f.name) === "pptx")) throw new Error(PPTX_MSG);
        const cats = files.map((f) => categoryOf(extOf(f.name)));
        if (cats.every((c) => c === "image")) {
          item = files.length > 1
            ? { type: "slides", ...base, slides: files.map((f) => ({ src: registerFile(f, IMAGE_EXT), alt: "" })) }
            : { type: "image", ...base, src: registerFile(files[0], IMAGE_EXT) };
        } else if (files.length === 1 && (cats[0] === "video" || cats[0] === "pdf")) {
          item = { type: cats[0], ...base, src: registerFile(files[0], MEDIA_EXT) };
        } else {
          throw new Error("Add either images (several at once make a slide deck), or one video or PDF at a time.");
        }
      } else if (url) {
        const embed = toEmbedUrl(url);
        if (!embed) throw new Error("Only YouTube and Vimeo links can be embedded. Paste the video's page or share link.");
        item = { type: "embed", ...base, src: embed };
      } else {
        throw new Error("Choose a file or paste a link.");
      }
      list.push(item);
      setIndex(path, slideIndexOf(list, list.length - 1));
      return true;
    },
  });
  if (ok) changed();
}

async function addSlides(path, i) {
  const deck = getPath(state.data, path)[i];
  const ok = await openDialog({
    title: "Add slides to this deck",
    intro: "Select one or more slide images. They are added at the end; reorder them with the arrow buttons.",
    fields: [{ name: "files", label: "Slide images", type: "file", multiple: true, accept: accept([...IMAGE_EXT, "pptx"]), help: FILE_HELP }],
    confirmLabel: "Add slides",
    onSubmit: ({ files }) => {
      if (!files.length) throw new Error("Choose at least one image.");
      if (files.some((f) => extOf(f.name) === "pptx")) throw new Error(PPTX_MSG);
      deck.slides.push(...files.map((f) => ({ src: registerFile(f, IMAGE_EXT), alt: "" })));
      return true;
    },
  });
  if (ok) changed();
}
