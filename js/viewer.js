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
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-viewer-step], [data-viewer-go]");
  if (btn) {
    const viewer = btn.closest("[data-viewer]");
    if (btn.dataset.viewerStep) step(viewer, Number(btn.dataset.viewerStep));
    else show(viewer, Number(btn.dataset.viewerGo));
    return;
  }
  const img = e.target.closest("[data-viewer] img[data-lightbox]");
  if (img && !editing()) openLightbox(img);
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
function openLightbox(startImg) {
  const viewer = startImg.closest("[data-viewer]");
  const imgs = [...viewer.querySelectorAll("img[data-lightbox]")].filter((i) => i.getAttribute("src"));
  let index = Math.max(0, imgs.indexOf(startImg));

  const pic = el("img", { class: "lightbox__img", alt: "" });
  const frame = el("div", { class: "lightbox__frame" }, pic);
  const btn = (cls, label, icon, onclick) => el("button", { type: "button", class: `lightbox__btn ${cls}`, "aria-label": label, onclick }, icon);
  const zoom = btn("lightbox__zoom", "Zoom to 100%", svgZoom(), () => setZoom(!frame.classList.contains("is-zoomed")));
  const many = imgs.length > 1;
  const dlg = el("dialog", { class: "lightbox", "aria-label": viewer.getAttribute("aria-label") || "Image viewer" },
    frame,
    many ? btn("lightbox__prev", "Previous image", ICONS.prev(), () => go(-1)) : null,
    many ? btn("lightbox__next", "Next image", ICONS.next(), () => go(1)) : null,
    zoom,
    btn("lightbox__close", "Close (Esc)", svgClose(), () => dlg.close()));

  function setZoom(on) {
    frame.classList.toggle("is-zoomed", on);
    zoom.setAttribute("aria-label", on ? "Fit to screen" : "Zoom to 100%");
    zoom.setAttribute("aria-pressed", String(on));
  }
  function go(by) {
    index = (index + by + imgs.length) % imgs.length;
    render();
  }
  function render() {
    const src = imgs[index];
    pic.src = src.currentSrc || src.src;
    pic.alt = src.alt;
    dlg.setAttribute("aria-description", `Image ${index + 1} of ${imgs.length}`);
    setZoom(false);
  }

  frame.addEventListener("click", (e) => { if (e.target === pic) setZoom(!frame.classList.contains("is-zoomed")); });
  dlg.addEventListener("keydown", (e) => {
    if (many && e.key === "ArrowRight") { e.preventDefault(); go(1); }
    if (many && e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  });
  if (many) onSwipe(frame, go);
  dlg.addEventListener("close", () => {
    dlg.remove();
    // keep the inline viewer on the image last seen in the lightbox
    const slide = imgs[index].closest(".viewer__slide");
    show(viewer, slidesOf(viewer).indexOf(slide));
    imgs[index].focus?.();
  });

  render();
  document.body.append(dlg);
  dlg.showModal();
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
