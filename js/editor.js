// Owner editing mode.
//
// IMPORTANT: this file is loaded with a dynamic import() only AFTER a GitHub token has been
// verified, so none of these controls exist in the page for ordinary visitors. Even if someone
// loaded this file by hand, saving would fail: GitHub rejects writes without the owner's token.

import { CONFIG } from "../config.js";
import { state } from "./state.js";
import { renderAll } from "./render.js";
import { setIndex } from "./viewer.js";
import { el, getPath, setPath, uid, safeUrl, toEmbedUrl, pending, slugFileName, fileToBase64, textToBase64 } from "./util.js";
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
export async function startEditor({ token: verifiedToken }) {
  token = verifiedToken;
  ui.fab = document.getElementById("owner-login");
  ui.fab.classList.add("is-owner");
  ui.fab.append(el("span", { class: "edit-fab__label", "aria-hidden": "true" }, "EXIT"));

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
const ROOTS = "#top, main, footer";

function decorate() {
  const all = (sel) => document.querySelectorAll(ROOTS.split(", ").map((r) => `${r} ${sel}`).join(", "));
  // Accordion rows are forced open in edit mode so every field can be reached and edited.
  all("details").forEach((d) => { d.open = true; });
  all("summary").forEach((s) => s.addEventListener("click", (e) => e.preventDefault()));
  all("[data-edit]").forEach(makeEditable);
  // While editing, links (nav, buttons, brand, social icons, files) must not navigate away.
  all("a").forEach((a) => a.addEventListener("click", (e) => e.preventDefault()));
  const main = document.querySelector("main");
  main.querySelectorAll("[data-img]").forEach(decorateImage);
  main.querySelectorAll("[data-viewer]").forEach(decorateViewer);
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
        { name: "file", label: "Or upload a file", type: "file", accept: accept(ANY_EXT), help: FILE_HELP },
      ],
      confirmLabel: "Add",
      onSubmit: ({ label, url, file }) => {
        if (!label) throw new Error("Enter the link text.");
        let value;
        if (file) value = registerFile(file, ANY_EXT);
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
  projects: () => ({
    id: uid(), kind: "Project type", meta: "Event or date", title: "New project title", summary: "Short summary of the project.",
    citations: [], tags: [], image: "", imageAlt: "", links: [], placeholder: "",
    media: [], mediaPlaceholder: "Placeholder: add photos, slides, a PDF or a video",
    tools: "", toolsPlaceholder: "Placeholder: list the tools and methods used", learned: "", learnedPlaceholder: "Placeholder: add what you learned",
    github: "", live: "", document: "",
  }),
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

// --- Project media (viewer) ------------------------------------------------------
/** Index of the first viewer slide for media item `item` (slide decks take one slide per image). */
function slideIndexOf(list, item, slideInDeck = 0) {
  let n = 0;
  for (let k = 0; k < item; k++) n += list[k].type === "slides" ? (list[k].slides || []).length : 1;
  return n + slideInDeck;
}

function editableField(labelText, path) {
  const value = el("span", { class: "ed-alt__value", "data-edit": path }, getPath(state.data, path) || "");
  makeEditable(value);
  return el("span", { class: "ed-alt", "data-editor-ui": "" }, labelText, value);
}

function decorateViewer(viewer) {
  const path = viewer.dataset.media;
  const list = getPath(state.data, path);
  viewer.hidden = false;
  if (!list.length) {
    // Empty viewer: an editable "No media yet" label (ui.noImage) sits above any placeholder badge
    const none = el("p", { class: "muted viewer__none", "data-edit": "ui.noImage" }, state.data.ui.noImage);
    viewer.querySelector(".viewer__empty")?.prepend(none);
    makeEditable(none);
  }

  viewer.querySelectorAll(".viewer__slide").forEach((slideEl) => {
    const itemPath = slideEl.dataset.itemPath;
    const i = Number(itemPath.split(".").pop());
    const item = list[i];
    const deckPath = slideEl.dataset.slidePath;            // only for slide-deck images
    const j = deckPath ? Number(deckPath.split(".").pop()) : 0;
    const move = (to) => {
      const [moved] = list.splice(i, 1);
      list.splice(to, 0, moved);
      setIndex(path, slideIndexOf(list, to));
      changed();
    };
    const bar = el("div", { class: "ed-media", "data-editor-ui": "" },
      el("span", { class: "ed-media__group" },
        i > 0 ? button("↑ Earlier", () => move(i - 1)) : null,
        i < list.length - 1 ? button("↓ Later", () => move(i + 1)) : null,
        button(item.type === "slides" ? "Remove deck" : "Remove", async () => {
          if (!(await confirmDialog(`Remove this ${item.type === "slides" ? "slide deck" : item.type}? The change is applied when you press Save.`, "Remove"))) return;
          list.splice(i, 1);
          setIndex(path, Math.max(0, slideIndexOf(list, Math.min(i, list.length - 1))));
          changed();
        }, "ed-btn--danger")));

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
    slideEl.querySelector(".viewer__frame").after(bar, editableField(altLabel, altPath));
  });

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
