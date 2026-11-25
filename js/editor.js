// Owner editing mode.
//
// IMPORTANT: this file is loaded with a dynamic import() only AFTER a GitHub token has been
// verified, so none of these controls exist in the page for ordinary visitors. Even if someone
// loaded this file by hand, saving would fail: GitHub rejects writes without the owner's token.

import { CONFIG } from "../config.js";
import { state } from "./state.js";
import { renderAll } from "./render.js";
import { el, getPath, setPath, uid, safeUrl, pending, slugFileName, fileToBase64, textToBase64 } from "./util.js";
import { openDialog, confirmDialog, toast } from "./dialog.js";
import { fetchRemoteData, commitFiles } from "./github.js";
import { signOut } from "./auth.js";

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"]; // SVG deliberately excluded (can contain scripts)
const DOC_EXT = ["pdf", "docx", "pptx", "xlsx", "csv", "txt", "md", "json", "zip"];

// Plain-text-only editing where supported (Chrome, Safari, recent Firefox); paste is sanitised anyway.
const PLAIN_TEXT = (() => { const d = document.createElement("div"); d.contentEditable = "plaintext-only"; return d.contentEditable === "plaintext-only"; })();

let token = null;
let editing = false;
let dirty = false;
let saving = false;
const committed = new Set(); // uploaded paths already saved this session
const ui = {};

// ---------------------------------------------------------------------------
/**
 * Starts owner mode. Returns { toggle } so the top-bar pencil (#owner-login, wired in main.js)
 * can switch edit mode on and off. Edit mode starts ON, so everything is editable straight away.
 */
export async function startEditor({ token: verifiedToken }) {
  token = verifiedToken;
  ui.fab = document.getElementById("owner-login");
  ui.fab.classList.add("is-owner");

  // Edit from the newest saved copy on GitHub, not the Pages copy (which can lag a few minutes).
  try {
    const remote = await fetchRemoteData(token, CONFIG.github, CONFIG.dataPath);
    if (JSON.stringify(remote) !== JSON.stringify(state.data)) {
      state.data = remote;
      renderAll(state.data);
      toast("Loaded the latest saved version from GitHub.");
    }
  } catch {
    toast("Could not confirm the latest saved version on GitHub. Saving would overwrite any newer changes there.", "error");
  }

  buildToolbar();
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  setEditing(true);
  return { toggle: () => setEditing(!editing) };
}

// --- Toolbar ---------------------------------------------------------------
// Edit mode is toggled by the pencil in the top bar; this bar holds Save / Export / Log out.
function buildToolbar() {
  ui.save = el("button", { type: "button", class: "btn", disabled: "", onclick: doSave }, "Save changes");
  ui.exportBtn = el("button", { type: "button", class: "btn btn--ghost", onclick: exportJson }, "Export JSON");
  ui.logout = el("button", { type: "button", class: "btn btn--ghost", onclick: logout }, "Log out");
  ui.status = el("span", { class: "ownerbar__status", role: "status", "aria-live": "polite" }, "Signed in as owner");
  document.body.append(el("div", { class: "ownerbar", role: "region", "aria-label": "Owner tools" }, ui.save, ui.exportBtn, ui.logout, ui.status));
  document.body.classList.add("has-ownerbar");
}

function setStatus(text, isDirty = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("is-dirty", isDirty);
}

function markDirty() {
  dirty = true;
  if (!saving) ui.save.disabled = false;
  setStatus("Unsaved changes", true);
}

function setEditing(on) {
  editing = on;
  document.body.classList.toggle("editing", on);
  const label = on ? "Edit mode on: click to preview" : "Edit mode off: click to edit";
  ui.fab.setAttribute("aria-pressed", String(on));
  ui.fab.setAttribute("aria-label", label);
  ui.fab.dataset.tooltip = label.toLowerCase();
  rerender();
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
async function doSave() {
  if (saving || !dirty) return;
  saving = true;
  ui.save.disabled = true;
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
    setStatus("Saved");
    toast("Saved to GitHub. Visitors will see the update once GitHub Pages finishes publishing (usually within a few minutes).");
  } catch (e) {
    ui.save.disabled = false;
    setStatus("Save failed", true);
    toast(e.message || "Save failed.", "error");
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
/** Validates a chosen file and queues it for the next save. Returns its repository path. */
function registerFile(file, kind) {
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  const allowed = kind === "image" ? IMAGE_EXT : [...IMAGE_EXT, ...DOC_EXT];
  if (!allowed.includes(ext)) throw new Error(`.${ext || "?"} files are not allowed here. Allowed: ${allowed.join(", ")}`);
  if (file.size > CONFIG.maxUploadMB * 1024 * 1024) throw new Error(`File is larger than ${CONFIG.maxUploadMB} MB.`);
  const path = `${CONFIG.uploadDir}/${Date.now()}-${slugFileName(file.name)}`;
  pending.set(path, { file, url: URL.createObjectURL(file) });
  return path;
}

const FILE_HELP = `Images and documents up to ${CONFIG.maxUploadMB} MB. Files are public once saved to a public repository.`;

// --- Decorating the rendered page with edit controls ------------------------
// Brand (header) and footer text are editable too, so decorate all three page regions.
const ROOTS = "#top, main, footer";

function decorate() {
  const all = (sel) => document.querySelectorAll(ROOTS.split(", ").map((r) => `${r} ${sel}`).join(", "));
  all("[data-edit]").forEach(makeEditable);
  // While editing, links (nav, buttons, brand, social icons, files) must not navigate away.
  all("a").forEach((a) => a.addEventListener("click", (e) => e.preventDefault()));
  const main = document.querySelector("main");
  main.querySelectorAll("[data-img]").forEach(decorateImage);
  main.querySelectorAll("[data-tags]").forEach(decorateTags);
  main.querySelectorAll("[data-links]").forEach(decorateLinks);
  main.querySelectorAll("[data-url]").forEach(decorateUrl);
  main.querySelectorAll("[data-collection]").forEach(decorateCollection);
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
  });
  node.addEventListener("paste", (e) => {
    e.preventDefault();
    let text = (e.clipboardData || window.clipboardData).getData("text/plain");
    if (!multi) text = text.replace(/\s*\n+\s*/g, " ");
    document.execCommand("insertText", false, text);
  });
}

// Images (profile photo, project images)
function decorateImage(node) {
  const path = node.dataset.img;
  const has = Boolean(getPath(state.data, path));
  const isProfile = path === "profile.photo";
  node.hidden = false;
  if (!has && !isProfile) {
    const none = el("span", { class: "muted", "data-edit": "ui.noImage" }, state.data.ui.noImage);
    node.append(none);
    makeEditable(none);
  }
  const controls = el("span", { class: "ed-inline", "data-editor-ui": "" },
    button(has ? (isProfile ? "Replace photo" : "Replace image") : isProfile ? "Add photo" : "Add image", () => chooseImage(path)),
    has ? button("Remove", () => { setPath(state.data, path, ""); changed(); }, "ed-btn--danger") : null);
  node.after(controls);
  // Alt text (read by screen readers) for an image that is present
  const altPath = node.dataset.alt;
  if (has && altPath) {
    const value = el("span", { class: "ed-alt__value", "data-edit": altPath }, getPath(state.data, altPath) || "");
    controls.after(el("span", { class: "ed-alt", "data-editor-ui": "" }, "Alt text: ", value));
    makeEditable(value);
    value.addEventListener("input", () => { const img = node.querySelector("img"); if (img) img.alt = value.textContent; });
  }
}

async function chooseImage(path) {
  const ok = await openDialog({
    title: "Choose an image",
    intro: "PNG, JPG, WebP or GIF.",
    fields: [{ name: "file", label: "Image file", type: "file", accept: ".png,.jpg,.jpeg,.webp,.gif", help: FILE_HELP }],
    confirmLabel: "Use image",
    onSubmit: ({ file }) => {
      if (!file) throw new Error("Choose a file first.");
      setPath(state.data, path, registerFile(file, "image"));
      return true;
    },
  });
  if (ok) changed();
}

// Tag lists (skills, project tags)
function decorateTags(ul) {
  const path = ul.dataset.tags;
  ul.querySelectorAll(":scope > li").forEach((li, i) => {
    li.append(button("✕", () => { getPath(state.data, path).splice(i, 1); changed(); }, "ed-btn--danger"));
    li.lastChild.setAttribute("aria-label", `Remove ${li.textContent.replace("✕", "").trim()}`);
  });
  ul.append(el("li", {}, button("+ Add tag", async () => {
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

// Project links / attached documents
function decorateLinks(ul) {
  const path = ul.dataset.links;
  ul.querySelectorAll(":scope > li").forEach((li, i) => {
    li.append(button("✕", () => { getPath(state.data, path).splice(i, 1); changed(); }, "ed-btn--danger"));
    li.lastChild.setAttribute("aria-label", "Remove link");
  });
  ul.append(el("li", {}, button("+ Add link or file", async () => {
    const ok = await openDialog({
      title: "Add a link or attached file",
      fields: [
        { name: "label", label: "Link text", value: "" },
        { name: "url", label: "Web address", help: "https://… — or leave empty and upload a file below." },
        { name: "file", label: "Or upload a file", type: "file", accept: [...IMAGE_EXT, ...DOC_EXT].map((e) => "." + e).join(","), help: FILE_HELP },
      ],
      confirmLabel: "Add",
      onSubmit: ({ label, url, file }) => {
        if (!label) throw new Error("Enter the link text.");
        let value;
        if (file) value = registerFile(file, "any");
        else {
          value = safeUrl(url);
          if (!value) throw new Error("Enter a valid https:// or mailto: address, or choose a file.");
        }
        getPath(state.data, path).push({ label, url: value });
        return true;
      },
    });
    if (ok) changed();
  })));
}

// Edit the URL / uploaded file behind any [data-url] element (documents, links, LinkedIn)
function decorateUrl(node) {
  const path = node.dataset.url;
  if (node.dataset.urlKind === "email") return decorateEmail(node, path);
  const btn = button("Edit link", async () => {
    const current = getPath(state.data, path) || "";
    const ok = await openDialog({
      title: "Edit link or file",
      fields: [
        { name: "url", label: "Web address", value: pending.has(current) ? "" : current, help: "https://… Leave empty to clear it." },
        { name: "file", label: "Or upload a file", type: "file", accept: [...IMAGE_EXT, ...DOC_EXT].map((e) => "." + e).join(","), help: FILE_HELP },
      ],
      confirmLabel: "Update",
      onSubmit: ({ url, file }) => {
        if (file) setPath(state.data, path, registerFile(file, "any"));
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
  btn.classList.add("ed-inline");
  node.after(btn);
}

// The email icon stores a bare address (profile.email); the page builds the mailto: link.
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
  btn.classList.add("ed-inline");
  node.after(btn);
}

// Add / remove items in a list. A container's data-template picks the template (default: its path).
const entryTemplate = () => ({ role: "New role", org: "Organisation", place: "Place", dates: "Dates", summary: "", bullets: ["New bullet point"] });
const TEMPLATES = {
  projects: () => ({ id: uid(), kind: "Project type", meta: "Event or date", title: "New project title", summary: "Short summary of the project.", citations: [], tags: [], image: "", imageAlt: "", links: [], placeholder: "" }),
  documents: () => ({ id: uid(), kind: "PDF", title: "New document", note: "Short description.", url: "", placeholder: "" }),
  entry: entryTemplate,                       // experience + additional experience
  education: () => ({ degree: "New qualification", school: "Institution", place: "Place", dates: "Dates", bullets: ["New bullet point"] }),
  skills: () => ({ group: "New skill group", items: [] }),
  bullet: () => "New bullet point",
  citation: () => "New citation",
};

function itemName(value) {
  if (typeof value === "string") return value.length > 50 ? `${value.slice(0, 50)}…` : value;
  return value?.title || value?.role || value?.degree || value?.group || "this item";
}

function decorateCollection(container) {
  const path = container.dataset.collection;
  const template = TEMPLATES[container.dataset.template || path];
  if (!template) return;
  container.querySelectorAll(":scope > [data-item]").forEach((item) => {
    const index = Number(item.dataset.item.split(".").pop());
    const value = getPath(state.data, item.dataset.item);
    const small = typeof value === "string"; // bullet points / citations: inline ✕, no confirmation
    const remove = async () => {
      if (!small && !(await confirmDialog(`Remove "${itemName(value)}"? The change is applied when you press Save.`, "Remove"))) return;
      getPath(state.data, path).splice(index, 1);
      changed();
    };
    const btn = button(small ? "✕" : "Remove", remove, small ? "ed-btn--danger ed-inline" : "ed-btn--danger ed-btn--corner");
    btn.setAttribute("aria-label", `Remove ${itemName(value)}`);
    item.append(btn);
  });
  container.after(el("button", {
    type: "button",
    class: "btn btn--ghost ed-add",
    onclick: () => { getPath(state.data, path).push(template()); changed(); },
  }, container.dataset.addLabel || "Add"));
}

// "Placeholder" badges can be dismissed once the real content is in
function decorateBadge(node) {
  const path = node.dataset.badge;
  node.after(el("span", { class: "ed-inline", "data-editor-ui": "" }, button("Dismiss tag", () => { setPath(state.data, path, ""); changed(); })));
}
