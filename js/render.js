// Renders the page from data. Pure display code: it never writes data (apart from filling in
// missing keys with defaults, so every editable path exists).
//
// It marks elements with data attributes that the owner editor (editor.js, only
// loaded after sign-in) looks for:
//   data-edit="path"        editable text           (+ data-multiline for paragraphs)
//   data-tags="path"        list of tag strings
//   data-links="path"       list of {label,url}
//   data-url="path"         element whose value is a URL / uploaded file path (+ data-url-kind="email")
//   data-img="path"         image slot (+ data-alt="path" for its alt text)
//   data-media="path"       project media viewer (list of media items; see viewer.js)
//   data-collection="path"  list that can be added to/removed from (children have data-item;
//                           data-template names the TEMPLATES entry used for new items)
//   data-badge="path"       placeholder badge text
// Visitors get these attributes too, but without editor.js they do nothing.
//
// Every visible piece of text inside <main> is rendered inside a [data-edit] element, so
// the owner can change all of it. Separators (" – ", ", ") come from CSS, not text nodes.

import { el, svg, resolveUrl, initials, localMediaUrl, safeEmbedUrl } from "./util.js";

export const RENDERED_EVENT = "portfolio:rendered";

const ed = (path, multiline = false) => (multiline ? { "data-edit": path, "data-multiline": "1" } : { "data-edit": path });

function badge(path, text) {
  return text ? el("span", { class: "badge", "data-edit": path, "data-badge": path, title: "Placeholder content: replace before sharing" }, text) : null;
}

/** Pill list. `pill` names the colour context (skills | tags), see --pill-* tokens in styles.css. */
const tagList = (path, items, pill) =>
  el("ul", { class: "tags", "data-tags": path, "data-pill": pill },
    items.map((t, i) => el("li", { class: "tag" }, el("span", ed(`${path}.${i}`), t))));

const linkList = (path, links) =>
  el("ul", { class: "links", "data-links": path },
    links.map((l, j) => {
      const href = resolveUrl(l.url);
      return el("li", {},
        el("a", { "data-url": `${path}.${j}.url`, href: href || null, target: "_blank", rel: "noopener noreferrer" },
          el("span", ed(`${path}.${j}.label`), l.label)));
    }));

function heading(id, path, text, level = "h2", cls = "section__title") {
  return el(level, { id, class: cls, ...ed(path) }, text);
}

// --- Defaults: fill in anything an older data.json lacks, so every edit path exists ---
const DEFAULT_UI = {
  brand: "", viewProjects: "View projects", getInTouch: "Get in touch",
  contactEmail: "Email", contactLinkedIn: "LinkedIn", contactLocation: "Location",
  viewProfile: "View profile", openFile: "Open file", fileMissing: "File not added yet",
  noImage: "No media yet", footer: "", backToTop: "Back to top",
  accOverview: "Overview", accTools: "Tools used / how it was built", accLearned: "What I learned",
  accDocs: "View full documents", openFullSize: "Open PDF full size",
};
const DEFAULT_NAV = [
  { id: "overview", label: "Overview" }, { id: "skills", label: "Skills" },
  { id: "experience", label: "Experience" }, { id: "education", label: "Education" },
  { id: "work", label: "Projects & Documents" }, { id: "contact", label: "Contact" },
];
const DEFAULT_HEADINGS = {
  skills: "Skills", experience: "Employment", additional: "Additional experience", education: "Education",
  work: "Projects & Documents", projects: "Projects", documents: "Documents", contact: "Contact",
};

export function ensureShape(d) {
  d.profile ||= {};
  d.ui = { ...DEFAULT_UI, ...(d.ui || {}) };
  if (!d.ui.brand) d.ui.brand = d.profile.name || "";
  if (!d.ui.footer) d.ui.footer = `${d.profile.name || ""} · Biochemistry`;
  if (!Array.isArray(d.nav) || !d.nav.length) d.nav = DEFAULT_NAV.map((n) => ({ ...n }));
  d.headings = { ...DEFAULT_HEADINGS, ...(d.headings || {}) };
  for (const key of ["skills", "experience", "additional", "education", "projects", "documents"]) if (!Array.isArray(d[key])) d[key] = [];
  for (const x of [...d.experience, ...d.additional, ...d.education]) { x.bullets ||= []; x.place ??= ""; }
  for (const p of d.projects) {
    p.citations ||= []; p.imageAlt ??= ""; p.tags ||= []; p.links ||= [];
    if (!Array.isArray(p.media)) p.media = p.image ? [{ type: "image", src: p.image, alt: p.imageAlt || "", caption: "", poster: "" }] : [];
    for (const k of ["tools", "learned", "toolsPlaceholder", "learnedPlaceholder", "mediaPlaceholder", "github", "live", "document"]) p[k] ??= "";
  }
  for (const g of d.skills) g.items ||= [];
  for (const k of ["github", "cv", "photoAlt", "photoPlaceholder", "githubPlaceholder", "cvPlaceholder", "emailPlaceholder"]) d.profile[k] ??= "";
  d.contact ||= { intro: "" };
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
};

/**
 * Shared round icon button (hero links and project panels). One pattern for all kinds:
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
  }, ICONS[kind]());
}

// --- Sections ---------------------------------------------------------------

function overview(d) {
  const p = d.profile;
  const photo = p.photo
    ? el("img", { src: resolveUrl(p.photo), alt: p.photoAlt || "" })
    : null;
  const side = el("div", { class: "hero__side" },
    el("div", { class: "avatar", "data-img": "profile.photo", "data-alt": "profile.photoAlt", "data-initials": p.photo ? null : initials(p.name) }, photo),
    p.photo ? null : badge("profile.photoPlaceholder", p.photoPlaceholder),
    el("nav", { class: "side-nav", "aria-label": "Sections", "data-nav": "" },
      el("ul", {}, d.nav.map((n, i) =>
        el("li", {}, el("a", { href: `#${n.id}` }, el("span", ed(`nav.${i}.label`), n.label)))))));

  const body = el("div", { class: "hero__body", "data-section-box": "" },
    el("p", { class: "eyebrow", ...ed("profile.eyebrow") }, p.eyebrow),
    el("h1", { id: "overview-heading", ...ed("profile.name") }, p.name),
    el("p", { class: "headline", ...ed("profile.headline") }, p.headline),
    el("p", { class: "bio", ...ed("profile.bio", true) }, p.bio),
    el("div", { class: "cta" },
      el("a", { class: "btn", href: "#work" }, el("span", ed("ui.viewProjects"), d.ui.viewProjects)),
      el("a", { class: "btn btn--ghost", href: "#contact" }, el("span", ed("ui.getInTouch"), d.ui.getInTouch))),
    el("div", { class: "socials" },
      iconButton({ kind: "linkedin", label: "LinkedIn profile", path: "profile.linkedin", href: resolveUrl(p.linkedin), external: true }),
      iconButton({ kind: "email", label: `Email ${p.name}`, path: "profile.email", href: p.email ? `mailto:${p.email}` : null, external: false, extra: { "data-url-kind": "email" } }),
      iconButton({ kind: "cv", label: "CV", path: "profile.cv", href: resolveUrl(p.cv), external: true }),
      iconButton({ kind: "github", label: "GitHub profile", path: "profile.github", href: resolveUrl(p.github), external: true })),
    el("div", { class: "badges" },
      p.github ? null : badge("profile.githubPlaceholder", p.githubPlaceholder),
      p.cv ? null : badge("profile.cvPlaceholder", p.cvPlaceholder)));

  return [side, body];
}

function skills(d) {
  return [
    heading("skills-heading", "headings.skills", d.headings.skills),
    el("div", { class: "skill-groups", "data-collection": "skills", "data-template": "skills", "data-add-label": "Add skill group" },
      d.skills.map((g, i) =>
        el("div", { class: "skill-group", "data-item": `skills.${i}` },
          el("h3", ed(`skills.${i}.group`), g.group),
          tagList(`skills.${i}.items`, g.items, "skills")))),
  ];
}

const bulletList = (path, items) =>
  el("ul", { class: "entry__bullets", "data-collection": path, "data-template": "bullet", "data-add-label": "Add bullet point" },
    items.map((b, i) => el("li", { "data-item": `${path}.${i}` }, el("span", ed(`${path}.${i}`), b))));

/** One CV-style entry: "Title – Organisation, Place" with dates right-aligned, then bullets. */
function entry(base, x, titleKey, orgKey) {
  return el("article", { class: "entry", "data-item": base },
    el("div", { class: "entry__head" },
      el("h3", { class: "entry__title" },
        el("span", { class: "entry__role", ...ed(`${base}.${titleKey}`) }, x[titleKey]),
        el("span", { class: "entry__org", ...ed(`${base}.${orgKey}`) }, x[orgKey]),
        el("span", { class: "entry__place", ...ed(`${base}.place`) }, x.place)),
      el("span", { class: "entry__dates", ...ed(`${base}.dates`) }, x.dates)),
    x.summary ? el("p", { class: "entry__summary", ...ed(`${base}.summary`, true) }, x.summary) : null,
    bulletList(`${base}.bullets`, x.bullets));
}

const entries = (path, list, template, addLabel, titleKey, orgKey) =>
  el("div", { class: "entries", "data-collection": path, "data-template": template, "data-add-label": addLabel },
    list.map((x, i) => entry(`${path}.${i}`, x, titleKey, orgKey)));

function experience(d) {
  return [
    heading("experience-heading", "headings.experience", d.headings.experience),
    entries("experience", d.experience, "entry", "Add job", "role", "org"),
    heading("additional-heading", "headings.additional", d.headings.additional, "h3", "section__sub"),
    entries("additional", d.additional, "entry", "Add additional experience", "role", "org"),
  ];
}

function education(d) {
  return [
    heading("education-heading", "headings.education", d.headings.education),
    entries("education", d.education, "education", "Add education", "degree", "school"),
  ];
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
      out.push(slide(ip, el("div", { class: "viewer__pdf" },
        src ? el("iframe", { src: `${src}#view=FitH`, title: label, loading: "lazy" }) : null,
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

function viewer(p, b, ui) {
  const slides = mediaSlides(p, b, ui);
  const n = slides.length;
  slides.forEach((sl, k) => {
    sl.setAttribute("aria-label", `${k + 1} of ${n}`);
    if (k === 0) sl.classList.add("is-current"); else sl.hidden = true;
  });
  const navBtn = (dir) => el("button", { type: "button", class: `viewer__nav viewer__nav--${dir}`, "data-viewer-step": dir === "prev" ? "-1" : "1", "aria-label": dir === "prev" ? "Previous slide" : "Next slide" }, ICONS[dir]());
  return el("div", {
    class: "viewer", role: "region", "aria-roledescription": "carousel", "aria-label": `Media: ${p.title}`,
    "data-viewer": "", "data-media": `${b}.media`, "data-count": n, tabindex: n > 1 ? "0" : null,
    hidden: n || p.mediaPlaceholder ? null : "",
  },
    el("div", { class: "viewer__stage", "aria-live": "polite" },
      n ? slides : el("div", { class: "viewer__empty" }, badge(`${b}.mediaPlaceholder`, p.mediaPlaceholder))),
    n > 1 ? [navBtn("prev"), navBtn("next"),
      el("div", { class: "viewer__dots" }, slides.map((_, k) =>
        el("button", { type: "button", class: "viewer__dot", "data-viewer-go": k, "aria-label": `Show slide ${k + 1} of ${n}`, "aria-current": k === 0 ? "true" : null })))] : null);
}

function accordionRow(key, labelKey, ui, open, ...body) {
  return el("details", { class: `acc acc--${key}`, open: open ? "" : null },
    el("summary", {}, el("span", { class: "acc__label", ...ed(`ui.${labelKey}`) }, ui[labelKey]), ICONS.chevron()),
    el("div", { class: "acc__body" }, body));
}

function projectCard(p, i, ui) {
  const b = `projects.${i}`;
  return el("article", { class: "project", "data-item": b },
    viewer(p, b, ui),
    el("div", { class: "project__body" },
      el("p", { class: "chip", "data-pill": "kind", ...ed(`${b}.kind`) }, p.kind),
      el("h3", { class: "project__title", ...ed(`${b}.title`) }, p.title),
      el("p", { class: "project__meta", ...ed(`${b}.meta`) }, p.meta),
      tagList(`${b}.tags`, p.tags, "tags"),
      el("div", { class: "accordion" },
        accordionRow("overview", "accOverview", ui, true,
          el("p", { class: "project__summary", ...ed(`${b}.summary`, true) }, p.summary),
          el("ul", { class: "citations", "data-collection": `${b}.citations`, "data-template": "citation", "data-add-label": "Add citation" },
            p.citations.map((c, j) => el("li", { "data-item": `${b}.citations.${j}` }, el("span", ed(`${b}.citations.${j}`), c))))),
        accordionRow("tools", "accTools", ui, false,
          el("p", { class: "project__text", ...ed(`${b}.tools`, true) }, p.tools),
          badge(`${b}.toolsPlaceholder`, p.toolsPlaceholder)),
        accordionRow("learned", "accLearned", ui, false,
          el("p", { class: "project__text", ...ed(`${b}.learned`, true) }, p.learned),
          badge(`${b}.learnedPlaceholder`, p.learnedPlaceholder)),
        accordionRow("docs", "accDocs", ui, false, linkList(`${b}.links`, p.links))),
      el("div", { class: "socials project__buttons" },
        iconButton({ kind: "github", label: `GitHub repository: ${p.title}`, path: `${b}.github`, href: resolveUrl(p.github) }),
        iconButton({ kind: "live", label: `Live link: ${p.title}`, path: `${b}.live`, href: resolveUrl(p.live) }),
        iconButton({ kind: "document", label: `Document: ${p.title}`, path: `${b}.document`, href: resolveUrl(p.document) })),
      badge(`${b}.placeholder`, p.placeholder)));
}

function docRow(x, i, ui) {
  const b = `documents.${i}`;
  const href = resolveUrl(x.url);
  return el("li", { class: "card doc", "data-item": b },
    el("span", { class: "doc__kind", "data-pill": "docs", ...ed(`${b}.kind`) }, x.kind),
    el("div", {},
      el("p", { class: "doc__title", ...ed(`${b}.title`) }, x.title),
      el("p", { class: "doc__note", ...ed(`${b}.note`) }, x.note),
      badge(`${b}.placeholder`, x.placeholder)),
    href
      ? el("a", { class: "doc__action", "data-url": `${b}.url`, href, target: "_blank", rel: "noopener noreferrer" }, el("span", ed("ui.openFile"), ui.openFile))
      : el("span", { class: "doc__action muted", "data-url": `${b}.url` }, el("span", ed("ui.fileMissing"), ui.fileMissing)));
}

function work(d) {
  return [
    heading("work-heading", "headings.work", d.headings.work),
    heading("projects-heading", "headings.projects", d.headings.projects, "h3", "section__sub"),
    el("div", { class: "projects", "data-collection": "projects", "data-add-label": "Add project" }, d.projects.map((p, i) => projectCard(p, i, d.ui))),
    el("div", { class: "docs-wrap" },
      heading("documents-heading", "headings.documents", d.headings.documents, "h3", "section__sub"),
      el("ul", { class: "docs", "data-collection": "documents", "data-add-label": "Add document" }, d.documents.map((x, i) => docRow(x, i, d.ui)))),
  ];
}

function contact(d) {
  const p = d.profile;
  const mail = p.email ? `mailto:${p.email}` : null;
  return [
    heading("contact-heading", "headings.contact", d.headings.contact),
    el("div", { class: "contact" },
      el("p", { class: "contact__intro", ...ed("contact.intro", true) }, d.contact.intro),
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
        el("span", ed("profile.location"), p.location))),
  ];
}

// --- Public API -------------------------------------------------------------
const SECTIONS = { overview, skills, experience, education, work, contact };

export function renderAll(data) {
  ensureShape(data);
  document.title = `${data.profile.name} — Biochemistry Portfolio`;
  for (const [id, build] of Object.entries(SECTIONS)) {
    const section = document.getElementById(id);
    if (!section) continue;
    section.replaceChildren(...build(data).flat());
    const h = section.querySelector("h1, h2");
    if (h) section.setAttribute("aria-labelledby", h.id);
  }
  document.getElementById("brand-slot").replaceChildren(
    el("a", { class: "brand", href: "#top", id: "brand" }, el("span", ed("ui.brand"), data.ui.brand)));
  document.getElementById("footer-slot").replaceChildren(
    el("span", { id: "footer-name", ...ed("ui.footer") }, data.ui.footer),
    el("a", { href: "#top" }, el("span", ed("ui.backToTop"), data.ui.backToTop)));
  document.dispatchEvent(new Event(RENDERED_EVENT));
}
