// Project media viewer: prev/next arrows, dots, arrow keys, swipe, and a full-screen lightbox.
// Loaded for visitors (it is display code). Everything works by event delegation on the
// document, so it keeps working after renderAll() rebuilds the page. No inline styles or
// scripts are created, so the strict CSP is unaffected.

import { el } from "./util.js";
import { RENDERED_EVENT, ICONS } from "./render.js";

const current = new Map(); // data-media path -> slide index, kept across re-renders

const slidesOf = (viewer) => [...viewer.querySelectorAll(":scope > .viewer__stage > .viewer__slide")];

/** Shows slide `index` (wraps around) in a viewer and updates dots + labels. */
export function show(viewer, index) {
  const slides = slidesOf(viewer);
  if (!slides.length) return;
  const n = slides.length;
  const next = ((index % n) + n) % n;
  slides.forEach((s, i) => {
    const on = i === next;
    if (!on && !s.hidden) leaveSlide(s);
    s.hidden = !on;
    s.classList.toggle("is-current", on);
  });
  viewer.querySelectorAll(".viewer__dot").forEach((d, i) => {
    if (i === next) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current");
  });
  viewer.dataset.index = String(next);
  current.set(viewer.dataset.media, next);
}

/** Remembers which slide to show for a media list after the next render (used by the editor). */
export function setIndex(mediaPath, index) {
  current.set(mediaPath, index);
}

// Stop anything playing on a slide that is being hidden.
function leaveSlide(slide) {
  slide.querySelectorAll("video").forEach((v) => v.pause());
  // Third-party players cannot be paused from here (no scripts from them run in our page), so
  // reloading the iframe is the reliable way to stop the sound.
  slide.querySelectorAll("iframe.viewer__embed").forEach((f) => { const src = f.src; f.src = "about:blank"; f.src = src; });
}

const indexOf = (viewer) => Number(viewer.dataset.index || 0);
const step = (viewer, by) => show(viewer, indexOf(viewer) + by);
const editing = () => document.body.classList.contains("editing");

// --- Inline viewer -------------------------------------------------------------
/** Everything in a viewer that the lightbox can show (images, slide images, PDFs), in order. */
function lightboxItems(viewer) {
  return slidesOf(viewer).flatMap((slide, slideIndex) => {
    const img = slide.querySelector("img[data-lightbox]");
    if (img?.getAttribute("src")) return [{ type: "image", src: img.currentSrc || img.src, alt: img.alt, slide, slideIndex }];
    const pdf = slide.querySelector(".viewer__pdf[data-pdf-src]");
    if (pdf) return [{ type: "pdf", src: pdf.dataset.pdfSrc, title: pdf.dataset.pdfTitle || "Document", slide, slideIndex }];
    return [];
  });
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-viewer-step], [data-viewer-go]");
  if (btn) {
    const viewer = btn.closest("[data-viewer]");
    if (btn.dataset.viewerStep) step(viewer, Number(btn.dataset.viewerStep));
    else show(viewer, Number(btn.dataset.viewerGo));
    return;
  }
  if (editing()) return;
  // Image, slide or PDF in a viewer -> full-screen lightbox
  const opener = e.target.closest("[data-viewer] img[data-lightbox], [data-viewer] [data-lightbox-open]");
  if (opener) {
    const viewer = opener.closest("[data-viewer]");
    const items = lightboxItems(viewer);
    const slide = opener.closest(".viewer__slide");
    openLightbox(items, Math.max(0, items.findIndex((it) => it.slide === slide)), viewer);
    return;
  }
  // "View full documents": PDFs and images open in the lightbox; other files download as usual
  const doc = e.target.closest("a[data-doc-lightbox]");
  if (doc) {
    e.preventDefault();
    const links = [...doc.closest("ul").querySelectorAll("a[data-doc-lightbox]")];
    const items = links.map((a) => (a.dataset.docLightbox === "pdf"
      ? { type: "pdf", src: a.getAttribute("href"), title: a.dataset.docTitle || "Document" }
      : { type: "image", src: a.getAttribute("href"), alt: a.dataset.docTitle || "" }));
    openLightbox(items, links.indexOf(doc), null);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const viewer = e.target.closest?.("[data-viewer]");
  if (!viewer || e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO|IFRAME)$/.test(e.target.tagName)) return;
  e.preventDefault();
  step(viewer, e.key === "ArrowRight" ? 1 : -1);
});

// Swipe (touch / pen); vertical scrolling is left to the browser (touch-action: pan-y in CSS).
function onSwipe(target, handler) {
  let x0 = null, y0 = null;
  target.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") { x0 = e.clientX; y0 = e.clientY; } });
  target.addEventListener("pointerup", (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) handler(dx < 0 ? 1 : -1);
  });
}
// Inline viewers: one document-level swipe listener, resolved to the stage under the finger.
let swipeStage = null;
onSwipe(document, (by) => { if (swipeStage) step(swipeStage.closest("[data-viewer]"), by); });
document.addEventListener("pointerdown", (e) => { swipeStage = e.target.closest?.(".viewer__stage") || null; }, true);

// Restore each viewer's slide after a re-render (e.g. after an edit).
document.addEventListener(RENDERED_EVENT, () => {
  document.querySelectorAll("[data-viewer]").forEach((v) => {
    const i = current.get(v.dataset.media);
    if (i) show(v, Math.min(i, slidesOf(v).length - 1));
  });
});

// --- Lightbox (native <dialog>: Esc closes, focus is trapped and restored) -----------
function openLightbox(items, start, viewer) {
  if (!items.length) return;
  let index = start;
  const opener = document.activeElement;
  const frame = el("div", { class: "lightbox__frame" });
  const btn = (cls, label, icon, onclick) => el("button", { type: "button", class: `lightbox__btn ${cls}`, "aria-label": label, onclick }, icon);
  const zoom = btn("lightbox__zoom", "Zoom to 100%", svgZoom(), () => setZoom(!frame.classList.contains("is-zoomed")));
  const many = items.length > 1;
  const dlg = el("dialog", { class: "lightbox", "aria-label": viewer?.getAttribute("aria-label") || "Document viewer" },
    frame,
    many ? btn("lightbox__prev", "Previous", ICONS.prev(), () => go(-1)) : null,
    many ? btn("lightbox__next", "Next", ICONS.next(), () => go(1)) : null,
    zoom,
    btn("lightbox__close", "Close (Esc)", svgClose(), () => dlg.close()));

  function setZoom(on) {
    frame.classList.toggle("is-zoomed", on);
    zoom.setAttribute("aria-label", on ? "Fit to screen" : "Zoom to 100%");
    zoom.setAttribute("aria-pressed", String(on));
  }
  function go(by) {
    index = (index + by + items.length) % items.length;
    render();
  }
  function render() {
    const it = items[index];
    const node = it.type === "pdf"
      ? el("iframe", { class: "lightbox__pdf", src: `${it.src}#view=FitH`, title: it.title })
      : el("img", { class: "lightbox__img", src: it.src, alt: it.alt || "" });
    frame.replaceChildren(node);
    zoom.hidden = it.type === "pdf";
    dlg.setAttribute("aria-description", `${index + 1} of ${items.length}`);
    setZoom(false);
  }

  frame.addEventListener("click", (e) => { if (e.target.matches(".lightbox__img")) setZoom(!frame.classList.contains("is-zoomed")); });
  dlg.addEventListener("keydown", (e) => {
    if (many && e.key === "ArrowRight") { e.preventDefault(); go(1); }
    if (many && e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  });
  if (many) onSwipe(frame, go);
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (viewer && items[index].slideIndex !== undefined) show(viewer, items[index].slideIndex); // stay on the item last seen
    opener?.focus?.();
  });

  render();
  document.body.append(dlg);
  dlg.showModal();
  // Keep focus on the lightbox's own controls (not inside a PDF frame) so arrow keys and Esc work
  dlg.querySelector(many ? ".lightbox__next" : ".lightbox__close").focus();
}

function svgClose() {
  return iconPath("M6 6l12 12M18 6L6 18");
}
function svgZoom() {
  return iconPath("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6");
}
function iconPath(d) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", class: "icon", width: 24, height: 24, "aria-hidden": "true", focusable: "false" })) s.setAttribute(k, v);
  const p = document.createElementNS(ns, "path");
  for (const [k, v] of Object.entries({ d, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" })) p.setAttribute(k, v);
  s.append(p);
  return s;
}
