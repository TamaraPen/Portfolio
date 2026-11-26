// Renders the page from data. Pure display code: it never writes data (apart from filling in
// missing keys with defaults and migrating older data.json shapes, so every editable path exists).
//
// Page model (data.json v4): the Overview (profile) is pinned at the top; everything else is
// data.sections = [{ id, title, navLabel, blocks: [...] }], rendered in order, and the nav is
// built from that order. Block types: text, project, gallery, entries, tags, buttons,
// documents, contact.
//
// Attributes the owner editor (editor.js, only loaded after sign-in and a click on the pencil)
// looks for:
//   data-edit="path"        editable text           (+ data-multiline for paragraphs)
//   data-tags="path"        list of tag strings
//   data-url="path"         element whose value is a URL / uploaded file path (+ data-url-kind="email")
//   data-img="path"         image slot (+ data-alt="path" for its alt text)
//   data-media="path"       media viewer (list of media items; see viewer.js)
//   data-collection="path"  list that can be added to/removed from (children have data-item;
//                           data-template picks the template/adder; data-sortable="y|x" adds
//                           drag handles and up/down buttons)
//   data-doclinks="path"    a project's "View full documents" list
//   data-badge="path"       placeholder badge text
// Visitors get these attributes too, but without editor.js they do nothing.
//
// Every visible piece of text inside <main> is rendered inside a [data-edit] element, so
// the owner can change all of it. Separators (" – ", ", ") come from CSS, not text nodes.

import { el, svg, resolveUrl, initials, localMediaUrl, safeEmbedUrl, pending, uid } from "./util.js";

export const RENDERED_EVENT = "portfolio:rendered";

const ed = (path, multiline = false) => (multiline ? { "data-edit": path, "data-multiline": "1" } : { "data-edit": path });

function badge(path, text) {
  return text ? el("span", { class: "badge", "data-edit": path, "data-badge": path, title: "Placeholder content: replace before sharing" }, text) : null;
}

/** Pill list. `pill` names the colour context (skills), see --pill-* tokens in styles.css. */
const tagList = (path, items, pill) =>
  el("ul", { class: "tags", "data-tags": path, "data-pill": pill },
    items.map((t, i) => el("li", { class: "tag" }, el("span", ed(`${path}.${i}`), t))));

// --- Defaults + migration --------------------------------------------------------
const DEFAULT_UI = {
  brand: "", viewProjects: "View projects", getInTouch: "Get in touch",
  contactEmail: "Email", contactLinkedIn: "LinkedIn", contactLocation: "Location",
  viewProfile: "View profile", openFile: "Open", fileMissing: "File not added yet",
  noImage: "No image", footer: "", backToTop: "Back to top", navOverview: "Overview",
  accOverview: "Overview", accTools: "Tools used / how it was built", accLearned: "What I learned",
  accDocs: "View full documents", openFullSize: "Open PDF full size",
};
const OLD_HEADINGS = {
  skills: "Skills", experience: "Employment", additional: "Additional experience", education: "Education",
  work: "Projects & Documents", projects: "Projects", documents: "Documents", contact: "Contact",
};
export const BUTTON_KINDS = ["github", "live", "document", "linkedin", "email", "cv"];
const BUTTON_LABEL = { github: "GitHub", live: "Live link", document: "Document", linkedin: "LinkedIn", email: "Email", cv: "CV" };

/** Converts the v3 shape (fixed top-level lists) into sections of blocks. Loses nothing. */
function migrateToSections(d) {
  const H = { ...OLD_HEADINGS, ...(d.headings || {}) };
  const navLabel = (id, fallback) => (d.nav || []).find((n) => n.id === id)?.label || fallback;
  d.ui.navOverview = navLabel("overview", d.ui.navOverview);
  const entry = (x, t, o) => ({ role: x[t] || "", org: x[o] || "", place: x.place || "", dates: x.dates || "", summary: x.summary || "", bullets: x.bullets || [] });
  const project = (p) => {
    const media = Array.isArray(p.media) ? p.media : p.image ? [{ type: "image", src: p.image, alt: p.imageAlt || "", caption: "", poster: "" }] : [];
    // The old meta line (event · place · date) and citations are folded into the Overview text.
    const overview = [p.summary, p.meta, (p.citations || []).join("\n")].filter(Boolean).join("\n\n");
    return {
      id: p.id || uid(), type: "project", title: p.title || "",
      media,
      accordions: [
        { title: d.ui.accOverview, body: overview },
        { title: d.ui.accTools, body: p.tools || "" },
        { title: d.ui.accLearned, body: p.learned || "" },
      ],
      documents: (p.links || []).map((l) => ({ label: l.label || "", url: l.url || "" })),
      buttons: [{ kind: "github", url: p.github || "" }, { kind: "live", url: p.live || "" }, { kind: "document", url: p.document || "" }],
    };
  };
  d.sections = [
    { id: "skills", title: H.skills, navLabel: navLabel("skills", "Skills"), blocks: [
      { id: "skill-groups", type: "tags", title: "", groups: d.skills || [] }] },
    { id: "experience", title: H.experience, navLabel: navLabel("experience", "Experience"), blocks: [
      { id: "employment", type: "entries", title: "", addLabel: "Add job", items: (d.experience || []).map((x) => entry(x, "role", "org")) },
      { id: "additional", type: "entries", title: H.additional, addLabel: "Add additional experience", items: (d.additional || []).map((x) => entry(x, "role", "org")) }] },
    { id: "education", title: H.education, navLabel: navLabel("education", "Education"), blocks: [
      { id: "education-list", type: "entries", title: "", addLabel: "Add education", items: (d.education || []).map((x) => entry(x, "degree", "school")) }] },
    { id: "work", title: H.work, navLabel: navLabel("work", "Projects & Documents"), blocks: [
      { id: "projects-intro", type: "text", title: H.projects, body: "" },
      ...(d.projects || []).map(project),
      { id: "documents", type: "documents", title: H.documents, items: d.documents || [] }] },
    { id: "contact", title: H.contact, navLabel: navLabel("contact", "Contact"), blocks: [
      { id: "contact-details", type: "contact", intro: d.contact?.intro || "" }] },
  ];
  for (const k of ["skills", "experience", "additional", "education", "projects", "documents", "contact", "headings", "nav"]) delete d[k];
  d.version = 4;
}

const BLOCK_DEFAULTS = {
  text: { title: "", body: "" },
  project: { title: "", media: [], accordions: [], documents: [], buttons: [] },
  gallery: { title: "", media: [] },
  entries: { title: "", items: [], addLabel: "" },
  tags: { title: "", groups: [] },
  buttons: { buttons: [] },
  documents: { title: "", items: [] },
  contact: { intro: "" },
};

export function ensureShape(d) {
  d.profile ||= {};
  d.ui = { ...DEFAULT_UI, ...(d.ui || {}) };
  if (!d.ui.brand) d.ui.brand = d.profile.name || "";
  if (!d.ui.footer) d.ui.footer = `${d.profile.name || ""} · Biochemistry`;
  for (const k of ["github", "cv", "photoAlt", "photoPlaceholder", "githubPlaceholder", "cvPlaceholder", "emailPlaceholder"]) d.profile[k] ??= "";
  if (!Array.isArray(d.sections)) migrateToSections(d);
  for (const s of d.sections) {
    s.id ||= `section-${uid()}`;
    s.title ??= ""; s.navLabel ??= "";
    if (!Array.isArray(s.blocks)) s.blocks = [];
    for (const b of s.blocks) {
      b.id ||= uid();
      for (const [k, v] of Object.entries(BLOCK_DEFAULTS[b.type] || {})) b[k] ??= Array.isArray(v) ? [] : v;
      for (const x of b.items || []) if (b.type === "entries") { x.bullets ||= []; x.place ??= ""; x.summary ??= ""; }
      for (const g of b.groups || []) g.items ||= [];
    }
  }
  return d;
}

// --- Icons (inline SVG filled with currentColor, so CSS can recolour them; the CSP blocks external images) ---
const stroke = (d, w = 1.7) => ["path", { d, fill: "none", stroke: "currentColor", "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" }];
export const ICONS = {
  linkedin: () => svg("0 0 24 24", [
    ["rect", { x: 3.6, y: 9, width: 3.6, height: 11.4, rx: 0.4, fill: "currentColor" }],
    ["circle", { cx: 5.4, cy: 5.2, r: 2.1, fill: "currentColor" }],
    ["path", { fill: "currentColor", d: "M9.9 9h3.4v1.6c.6-1.1 2-1.9 3.8-1.9 3.2 0 4.3 2 4.3 5.1v6.6H18v-5.8c0-1.5-.4-2.6-1.9-2.6-1.6 0-2.4 1.1-2.4 2.7v5.7H9.9z" }],
  ]),
  // GitHub mark (Octicons "mark-github", MIT licence)
  github: () => svg("0 0 16 16", [
    ["path", { fill: "currentColor", d: "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" }],
  ]),
  // The owner's CV artwork (assets/icons/cv-mask.png) used as a CSS mask, so it recolours like the SVGs
  cv: () => el("span", { class: "icon icon--mask icon--cv", "aria-hidden": "true" }),
  // The owner's two Gmail artworks: pale (rest) and colour (hover / focus / press)
  email: () => [
    el("img", { class: "icon-img icon-img--rest", src: "assets/icons/gmail-rest.png", alt: "", width: 48, height: 48, decoding: "async" }),
    el("img", { class: "icon-img icon-img--active", src: "assets/icons/gmail-hover.png", alt: "", width: 48, height: 48, decoding: "async" }),
  ],
  live: () => svg("0 0 24 24", [stroke("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"), stroke("M3 12h18"), stroke("M12 3c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9c-2.5-2.6-3.6-5.6-3.6-9S9.5 5.6 12 3z")]),
  document: () => svg("0 0 24 24", [stroke("M6.5 3h7.5l4 4v14h-11.5z"), stroke("M14 3v4h4"), stroke("M9.3 11.5h5.9M9.3 14.5h5.9M9.3 17.5h3.8")]),
  chevron: () => svg("0 0 24 24", [stroke("M6 9l6 6 6-6", 2)], "icon icon--chevron"),
  prev: () => svg("0 0 24 24", [stroke("M15 5l-7 7 7 7", 2.2)]),
  next: () => svg("0 0 24 24", [stroke("M9 5l7 7-7 7", 2.2)]),
  expand: () => svg("0 0 24 24", [stroke("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5", 2)]),
};

/**
 * Shared round icon button (hero links, project panels, icon-button rows). One pattern for all:
 * pale tinted circle + coloured glyph at rest; solid colour + white glyph on hover/focus/press.
 * External links open in a new tab; mailto: does not. The href is editable via data-url.
 */
export function iconButton({ kind, label, path, href, external = true, extra = {} }) {
  return el("a", {
    class: `social social--${kind}${href ? "" : " is-empty"}`,
    href: href || null,
    "data-url": path,
    target: external ? "_blank" : null,
    rel: "noopener noreferrer",
    "aria-label": href ? label : `${label} (not added yet)`,
    title: label,
    ...extra,
  }, (ICONS[kind] || ICONS.live)());
}

/** href for a stored button value: email buttons hold a bare address; the rest a URL/upload path. */
function buttonHref(kind, value) {
  if (kind === "email") return value ? `mailto:${value}` : null;
  return resolveUrl(value) || null;
}

// --- Overview (pinned at the top; holds the section nav) ---------------------------
function overview(d) {
  const p = d.profile;
  const photo = p.photo ? el("img", { src: resolveUrl(p.photo), alt: p.photoAlt || "" }) : null;
  const navItems = [{ id: "overview", label: d.ui.navOverview, path: "ui.navOverview" },
    ...d.sections.map((s, i) => ({ id: s.id, label: s.navLabel || s.title, path: s.navLabel ? `sections.${i}.navLabel` : `sections.${i}.title` }))];
  const side = el("div", { class: "hero__side" },
    el("div", { class: "avatar", "data-img": "profile.photo", "data-alt": "profile.photoAlt", "data-initials": p.photo ? null : initials(p.name) }, photo),
    p.photo ? null : badge("profile.photoPlaceholder", p.photoPlaceholder),
    el("nav", { class: "side-nav", "aria-label": "Sections", "data-nav": "" },
      el("ul", {}, navItems.map((n) =>
        el("li", {}, el("a", { href: `#${n.id}` }, el("span", ed(n.path), n.label)))))));

  const body = el("div", { class: "hero__body", "data-section-box": "" },
    el("p", { class: "eyebrow", ...ed("profile.eyebrow") }, p.eyebrow),
    el("h1", { id: "overview-heading", ...ed("profile.name") }, p.name),
    el("p", { class: "headline", ...ed("profile.headline") }, p.headline),
    el("p", { class: "bio", ...ed("profile.bio", true) }, p.bio),
    el("div", { class: "cta" },
      el("a", { class: "btn", href: "#work" }, el("span", ed("ui.viewProjects"), d.ui.viewProjects)),
      el("a", { class: "btn btn--ghost", href: "#contact" }, el("span", ed("ui.getInTouch"), d.ui.getInTouch))),
    el("div", { class: "socials" },
      iconButton({ kind: "linkedin", label: "LinkedIn profile", path: "profile.linkedin", href: resolveUrl(p.linkedin) }),
      iconButton({ kind: "email", label: `Email ${p.name}`, path: "profile.email", href: p.email ? `mailto:${p.email}` : null, external: false, extra: { "data-url-kind": "email" } }),
      iconButton({ kind: "cv", label: "CV", path: "profile.cv", href: resolveUrl(p.cv) }),
      iconButton({ kind: "github", label: "GitHub profile", path: "profile.github", href: resolveUrl(p.github) })),
    el("div", { class: "badges" },
      p.github ? null : badge("profile.githubPlaceholder", p.githubPlaceholder),
      p.cv ? null : badge("profile.cvPlaceholder", p.cvPlaceholder)));

  return [side, body];
}

// --- Project media viewer -------------------------------------------------------
// Each media item becomes one or more slides. Behaviour (arrows, dots, keys, swipe, lightbox)
// lives in viewer.js and works by event delegation, so re-rendering is safe.
function slide(itemPath, content, caption, extra = {}) {
  return el("figure", { class: "viewer__slide", role: "group", "aria-roledescription": "slide", "data-item-path": itemPath, ...extra },
    el("div", { class: "viewer__frame", "data-pos": extra["data-pos"] || null }, content),
    el("figcaption", { class: "viewer__caption", ...ed(`${itemPath}.caption`) }, caption || ""));
}

function mediaSlides(p, b, ui) {
  const out = [];
  p.media.forEach((m, i) => {
    const ip = `${b}.media.${i}`;
    const label = m.alt || m.caption || p.title;
    if (m.type === "image") {
      out.push(slide(ip, el("img", { class: "viewer__media", src: localMediaUrl(m.src) || null, alt: m.alt || "", "data-lightbox": "", "data-alt-path": `${ip}.alt`, decoding: "async" }), m.caption));
    } else if (m.type === "slides") {
      const list = Array.isArray(m.slides) ? m.slides : [];
      list.forEach((sl, j) => out.push(slide(ip,
        el("img", { class: "viewer__media", src: localMediaUrl(sl.src) || null, alt: sl.alt || "", "data-lightbox": "", "data-alt-path": `${ip}.slides.${j}.alt`, decoding: "async" }),
        m.caption, { "data-slide-path": `${ip}.slides.${j}`, "data-pos": `${j + 1} / ${list.length}` })));
    } else if (m.type === "video") {
      out.push(slide(ip, el("video", {
        class: "viewer__media", controls: "", playsinline: "", preload: "metadata",
        src: localMediaUrl(m.src) || null, poster: localMediaUrl(m.poster) || null, "aria-label": label,
      }), m.caption));
    } else if (m.type === "pdf") {
      const src = localMediaUrl(m.src);
      out.push(slide(ip, el("div", { class: "viewer__pdf", "data-pdf-src": src || null, "data-pdf-title": label },
        src ? el("iframe", { src: `${src}#view=FitH`, title: label, loading: "lazy" }) : null,
        src ? el("button", { type: "button", class: "viewer__expand", "data-lightbox-open": "", "aria-label": `Open ${label} full screen` }, ICONS.expand()) : null,
        el("a", { class: "viewer__open btn btn--ghost", href: src || null, target: "_blank", rel: "noopener noreferrer" }, el("span", ed("ui.openFullSize"), ui.openFullSize))), m.caption));
    } else if (m.type === "embed") {
      const src = safeEmbedUrl(m.src);
      out.push(slide(ip, src
        ? el("iframe", {
          class: "viewer__embed", src, title: label, loading: "lazy", allowfullscreen: "",
          allow: "fullscreen; picture-in-picture; encrypted-media",
          sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
          referrerpolicy: "strict-origin-when-cross-origin",
        })
        : el("div", { class: "viewer__blocked", role: "img", "aria-label": "This video link is not allowed" }), m.caption));
    }
  });
  return out;
}

/** Media viewer for a project or gallery block. Not shown at all when there is no media
 *  (the editor reveals it in edit mode with just an "Add media" button). */
function viewer(p, b, ui) {
  const slides = mediaSlides(p, b, ui);
  const n = slides.length;
  slides.forEach((sl, k) => {
    sl.setAttribute("aria-label", `${k + 1} of ${n}`);
    if (k === 0) sl.classList.add("is-current"); else sl.hidden = true;
  });
  const navBtn = (dir) => el("button", { type: "button", class: `viewer__nav viewer__nav--${dir}`, "data-viewer-step": dir === "prev" ? "-1" : "1", "aria-label": dir === "prev" ? "Previous slide" : "Next slide" }, ICONS[dir]());
  return el("div", {
    class: "viewer", role: "region", "aria-roledescription": "carousel", "aria-label": `Media: ${p.title || "gallery"}`,
    "data-viewer": "", "data-media": `${b}.media`, "data-count": n, tabindex: n > 1 ? "0" : null,
    hidden: n ? null : "",
  },
    el("div", { class: "viewer__stage", "aria-live": "polite" }, slides),
    n > 1 ? [navBtn("prev"), navBtn("next"),
      el("div", { class: "viewer__dots" }, slides.map((_, k) =>
        el("button", { type: "button", class: "viewer__dot", "data-viewer-go": k, "aria-label": `Show slide ${k + 1} of ${n}`, "aria-current": k === 0 ? "true" : null })))] : null);
}

// --- Blocks ----------------------------------------------------------------------
function blockTitle(b, bp, cls = "section__sub") {
  return el("h3", { id: `${b.id}-heading`, class: `${cls} block__title`, ...ed(`${bp}.title`) }, b.title || "");
}

const LIGHTBOX_EXT = /\.(pdf|png|jpe?g|webp|gif)$/i;
function opensInLightbox(path) {
  if (pending.has(path)) return LIGHTBOX_EXT.test(pending.get(path).file.name);
  return LIGHTBOX_EXT.test(String(path || "").split(/[?#]/)[0]);
}

function accordionRow(a, ap) {
  return el("details", { class: "acc", "data-item": ap },
    el("summary", {}, el("span", { class: "acc__label", ...ed(`${ap}.title`) }, a.title), ICONS.chevron()),
    el("div", { class: "acc__body" }, el("p", { class: "acc__text", ...ed(`${ap}.body`, true) }, a.body)));
}

/** "View full documents": last dropdown row; only shown to visitors when there are documents. */
function documentsRow(p, bp, ui) {
  return el("details", { class: "acc acc--docs", hidden: p.documents.length ? null : "" },
    el("summary", {}, el("span", { class: "acc__label", ...ed("ui.accDocs") }, ui.accDocs), ICONS.chevron()),
    el("div", { class: "acc__body" },
      el("ul", { class: "doclinks", "data-doclinks": `${bp}.documents` }, p.documents.map((x, k) => {
        const dp = `${bp}.documents.${k}`;
        const href = resolveUrl(x.url);
        return el("li", { class: "doclink", "data-item": dp },
          el("span", { class: "doclink__label", ...ed(`${dp}.label`) }, x.label),
          href
            ? el("a", { class: "btn btn--ghost doclink__open", href, target: "_blank", rel: "noopener noreferrer", "data-url": `${dp}.url`,
              "data-doc-lightbox": opensInLightbox(x.url) ? (/\.pdf$/i.test(pending.get(x.url)?.file.name || x.url) ? "pdf" : "image") : null,
              "data-doc-title": x.label }, el("span", ed("ui.openFile"), ui.openFile))
            : el("span", { class: "doclink__open muted", "data-url": `${dp}.url` }, el("span", ed("ui.fileMissing"), ui.fileMissing)));
      }))));
}

function buttonRow(buttons, bp, title, extraClass = "") {
  return el("div", { class: `socials ${extraClass}`.trim() }, buttons.map((b, k) =>
    iconButton({ kind: b.kind, label: `${BUTTON_LABEL[b.kind] || "Link"}${title ? `: ${title}` : ""}`, path: `${bp}.buttons.${k}.url`,
      href: buttonHref(b.kind, b.url), external: b.kind !== "email", extra: b.kind === "email" ? { "data-url-kind": "email" } : {} })));
}

// Project: title on top; media viewer left (~58%) and dropdown rows right; rows span the full
// width when there is no media. Nothing else is shown in a project panel.
function projectBlock(p, bp, d) {
  return el("article", { class: `project${p.media.length ? "" : " project--no-media"}` },
    el("h3", { id: `${p.id}-heading`, class: "project__title", ...ed(`${bp}.title`) }, p.title),
    el("div", { class: "project__grid" },
      viewer(p, bp, d.ui),
      el("div", { class: "project__side" },
        el("div", { class: "accordion", "data-collection": `${bp}.accordions`, "data-template": "accordion", "data-sortable": "y", "data-add-label": "Add dropdown row" },
          p.accordions.map((a, k) => accordionRow(a, `${bp}.accordions.${k}`))),
        documentsRow(p, bp, d.ui),
        buttonRow(p.buttons, bp, p.title, "project__buttons"))));
}

function textBlock(b, bp) {
  return el("div", {}, blockTitle(b, bp), el("p", { class: "text-block", ...ed(`${bp}.body`, true) }, b.body));
}

function galleryBlock(b, bp, d) {
  return el("div", { class: `gallery${b.media.length ? "" : " gallery--empty"}` }, blockTitle(b, bp), viewer(b, bp, d.ui));
}

/** One CV-style entry: "Title – Organisation, Place" with dates right-aligned, then bullets. */
function entry(base, x) {
  return el("article", { class: "entry", "data-item": base },
    el("div", { class: "entry__head" },
      el("h4", { class: "entry__title" },
        el("span", { class: "entry__role", ...ed(`${base}.role`) }, x.role),
        el("span", { class: "entry__org", ...ed(`${base}.org`) }, x.org),
        el("span", { class: "entry__place", ...ed(`${base}.place`) }, x.place)),
      el("span", { class: "entry__dates", ...ed(`${base}.dates`) }, x.dates)),
    x.summary ? el("p", { class: "entry__summary", ...ed(`${base}.summary`, true) }, x.summary) : null,
    el("ul", { class: "entry__bullets", "data-collection": `${base}.bullets`, "data-template": "bullet", "data-add-label": "Add bullet point" },
      x.bullets.map((t, i) => el("li", { "data-item": `${base}.bullets.${i}` }, el("span", ed(`${base}.bullets.${i}`), t)))));
}

function entriesBlock(b, bp) {
  return el("div", {}, blockTitle(b, bp),
    el("div", { class: "entries", "data-collection": `${bp}.items`, "data-template": "entry", "data-add-label": b.addLabel || "Add entry" },
      b.items.map((x, i) => entry(`${bp}.items.${i}`, x))));
}

function tagsBlock(b, bp) {
  return el("div", {}, blockTitle(b, bp),
    el("div", { class: "skill-groups", "data-collection": `${bp}.groups`, "data-template": "skills", "data-add-label": "Add skill group" },
      b.groups.map((g, i) => el("div", { class: "skill-group", "data-item": `${bp}.groups.${i}` },
        el("h4", ed(`${bp}.groups.${i}.group`), g.group),
        tagList(`${bp}.groups.${i}.items`, g.items, "skills")))));
}

function buttonsBlock(b, bp) {
  return el("div", { class: "socials icon-row", "data-collection": `${bp}.buttons`, "data-template": "button", "data-add-label": "Add icon button" },
    b.buttons.map((x, k) => el("span", { class: "icon-row__item", "data-item": `${bp}.buttons.${k}` },
      iconButton({ kind: x.kind, label: BUTTON_LABEL[x.kind] || "Link", path: `${bp}.buttons.${k}.url`, href: buttonHref(x.kind, x.url),
        external: x.kind !== "email", extra: x.kind === "email" ? { "data-url-kind": "email" } : {} }))));
}

function docRow(x, dp, ui) {
  const href = resolveUrl(x.url);
  return el("li", { class: "card doc", "data-item": dp },
    el("span", { class: "doc__kind", "data-pill": "docs", ...ed(`${dp}.kind`) }, x.kind),
    el("div", {},
      el("p", { class: "doc__title", ...ed(`${dp}.title`) }, x.title),
      el("p", { class: "doc__note", ...ed(`${dp}.note`) }, x.note),
      badge(`${dp}.placeholder`, x.placeholder)),
    href
      ? el("a", { class: "doc__action", "data-url": `${dp}.url`, href, target: "_blank", rel: "noopener noreferrer" }, el("span", ed("ui.openFile"), ui.openFile))
      : el("span", { class: "doc__action muted", "data-url": `${dp}.url` }, el("span", ed("ui.fileMissing"), ui.fileMissing)));
}

function documentsBlock(b, bp, d) {
  return el("div", { class: "docs-wrap" }, blockTitle(b, bp),
    el("ul", { class: "docs", "data-collection": `${bp}.items`, "data-template": "documents", "data-add-label": "Add document" },
      b.items.map((x, i) => docRow(x, `${bp}.items.${i}`, d.ui))));
}

function contactBlock(b, bp, d) {
  const p = d.profile;
  const mail = p.email ? `mailto:${p.email}` : null;
  return el("div", { class: "contact" },
    el("p", { class: "contact__intro", ...ed(`${bp}.intro`, true) }, b.intro),
    el("p", { class: "contact__row" },
      el("span", { class: "contact__label", ...ed("ui.contactEmail") }, d.ui.contactEmail),
      el("a", { href: mail, "data-email": "1" }, el("span", ed("profile.email"), p.email)),
      badge("profile.emailPlaceholder", p.emailPlaceholder)),
    el("p", { class: "contact__row" },
      el("span", { class: "contact__label", ...ed("ui.contactLinkedIn") }, d.ui.contactLinkedIn),
      el("a", { "data-url": "profile.linkedin", href: resolveUrl(p.linkedin) || null, target: "_blank", rel: "noopener noreferrer" },
        el("span", ed("ui.viewProfile"), d.ui.viewProfile))),
    el("p", { class: "contact__row" },
      el("span", { class: "contact__label", ...ed("ui.contactLocation") }, d.ui.contactLocation),
      el("span", ed("profile.location"), p.location)));
}

const BLOCKS = {
  text: textBlock, project: projectBlock, gallery: galleryBlock, entries: entriesBlock,
  tags: tagsBlock, buttons: buttonsBlock, documents: documentsBlock, contact: contactBlock,
};

function block(b, bp, d) {
  const build = BLOCKS[b.type];
  if (!build) return null;
  const node = build(b, bp, d);
  node.classList.add("block", `block--${b.type}`);
  node.setAttribute("data-item", bp);
  node.setAttribute("data-block-id", b.id);
  return node;
}

function section(s, i, d) {
  const sp = `sections.${i}`;
  return el("section", { id: s.id, class: "section", "data-item": sp, "aria-labelledby": `${s.id}-heading` },
    el("h2", { id: `${s.id}-heading`, class: "section__title", ...ed(`${sp}.title`) }, s.title),
    el("div", { class: "blocks", "data-collection": `${sp}.blocks`, "data-template": "block", "data-sortable": "y", "data-add-label": "Add block" },
      s.blocks.map((b, j) => block(b, `${sp}.blocks.${j}`, d))));
}

// --- Public API -------------------------------------------------------------
export function renderAll(data) {
  ensureShape(data);
  document.title = `${data.profile.name} — Biochemistry Portfolio`;
  const ov = document.getElementById("overview");
  ov.replaceChildren(...overview(data));
  ov.setAttribute("aria-labelledby", "overview-heading");

  const main = document.getElementById("main");
  // Remove everything except the pinned Overview (generated sections and any editor controls)
  [...main.children].forEach((c) => { if (c.id !== "overview") c.remove(); });
  main.append(...data.sections.map((s, i) => section(s, i, data)));
  // The sections list itself is sortable in edit mode (Overview stays pinned: it has no data-item).
  Object.entries({ "data-collection": "sections", "data-template": "section", "data-sortable": "y", "data-add-label": "Add section", "data-add-inside": "" })
    .forEach(([k, v]) => main.setAttribute(k, v));
  main.style.setProperty("--rows", String(data.sections.length + 1)); // CSSOM, not a style attribute: CSP-safe

  document.getElementById("brand-slot").replaceChildren(
    el("a", { class: "brand", href: "#top", id: "brand" }, el("span", ed("ui.brand"), data.ui.brand)));
  document.getElementById("footer-slot").replaceChildren(
    el("span", { id: "footer-name", ...ed("ui.footer") }, data.ui.footer),
    el("a", { href: "#top" }, el("span", ed("ui.backToTop"), data.ui.backToTop)));
  document.dispatchEvent(new Event(RENDERED_EVENT));
}
