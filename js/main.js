// Entry point. Visitors only ever run this file + render.js (read-only view).

import { CONFIG } from "../config.js";
import { state } from "./state.js";
import { renderAll, RENDERED_EVENT } from "./render.js";
import { TOKEN_KEY } from "./util.js";

async function loadData() {
  // "no-cache" = always revalidate, so visitors see saved changes as soon as Pages has published them.
  const res = await fetch(CONFIG.dataPath, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load ${CONFIG.dataPath} (${res.status}).`);
  return res.json();
}

// --- Section navigation ------------------------------------------------------
// renderAll() rebuilds the nav (and the overview content) after every edit, so nothing here
// caches link nodes: the links are looked up fresh on every observer callback.
const navLinks = () => [...document.querySelectorAll("[data-nav] a[href^='#']")];

/** The element that actually has a box for a section (#overview is display:contents on wide screens). */
function boxFor(section) {
  if (getComputedStyle(section).display !== "contents") return section;
  return section.querySelector("[data-section-box]") || section.firstElementChild;
}

function setActive(id) {
  for (const a of navLinks()) {
    const on = a.getAttribute("href") === `#${id}`;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}

// The last panel (Contact) is short and can never reach the observer's band, so when the page
// is scrolled to the bottom the last section is highlighted instead.
const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
const lastSectionId = () => document.querySelector("main > section:last-of-type")?.id;

function initNavHighlight() {
  const observer = new IntersectionObserver((entries) => {
    if (atBottom()) { setActive(lastSectionId()); return; }
    for (const entry of entries) {
      if (entry.isIntersecting) setActive(entry.target.closest("main > section")?.id);
    }
  }, { rootMargin: "-40% 0px -55% 0px" });

  window.addEventListener("scroll", () => { if (atBottom()) setActive(lastSectionId()); }, { passive: true });

  const observeAll = () => {
    observer.disconnect();
    document.querySelectorAll("main > section").forEach((s) => { const box = boxFor(s); if (box) observer.observe(box); });
  };
  observeAll();
  document.addEventListener(RENDERED_EVENT, observeAll);
  window.addEventListener("resize", observeAll);

  // A display:contents section has no box to scroll to, so jump to the element that does.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='#']");
    if (!a || e.defaultPrevented || document.body.classList.contains("editing")) return;
    const target = document.getElementById(a.getAttribute("href").slice(1));
    if (!target || getComputedStyle(target).display !== "contents") return;
    e.preventDefault();
    boxFor(target)?.scrollIntoView({ block: "start" });
    history.replaceState(null, "", a.getAttribute("href"));
  });
}

// --- Owner tools ---------------------------------------------------------------
// Nothing from auth.js is loaded until the owner clicks the pencil, and editor.js is loaded
// only after a GitHub token has been verified. Visitors never download either.
let owner = null;   // { toggle } once the editor is running
let busy = false;

async function startOwnerMode(token) {
  const { startEditor } = await import("./editor.js");
  owner = await startEditor({ token });
}

function initOwnerLogin() {
  const btn = document.getElementById("owner-login");
  btn.addEventListener("click", async () => {
    if (owner) { owner.toggle(); return; }  // signed in: the pencil switches edit mode on/off
    if (busy) return;
    busy = true;
    try {
      const { promptLogin } = await import("./auth.js");
      const token = await promptLogin();
      if (token) await startOwnerMode(token);
    } finally {
      busy = false;
    }
  });
  // Same tab, already signed in earlier: restore the session.
  if (sessionStorage.getItem(TOKEN_KEY)) {
    busy = true;
    import("./auth.js")
      .then(async ({ restoreSession }) => {
        const token = await restoreSession();
        if (token) await startOwnerMode(token);
      })
      .finally(() => { busy = false; });
  }
}

async function init() {
  try {
    state.data = await loadData();
    renderAll(state.data);
  } catch (err) {
    document.getElementById("overview").replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "notice",
        textContent: `${err.message} If you opened index.html directly from disk, serve the folder instead (for example with VS Code Live Server or "python3 -m http.server"), because browsers block loading data.json from file:// pages.`,
      }),
    );
  }
  initNavHighlight();
  initOwnerLogin();
}

init();
