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
//   data-collection="path"  list that can be added to/removed from (children have data-item;
//                           data-template names the TEMPLATES entry used for new items)
//   data-badge="path"       placeholder badge text
// Visitors get these attributes too, but without editor.js they do nothing.
//
// Every visible piece of text inside <main> is rendered inside a [data-edit] element, so
// the owner can change all of it. Separators (" – ", ", ") come from CSS, not text nodes.

import { el, svg, resolveUrl, initials } from "./util.js";

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
  noImage: "No image", footer: "", backToTop: "Back to top",
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
  for (const p of d.projects) { p.citations ||= []; p.imageAlt ??= ""; p.tags ||= []; p.links ||= []; }
  for (const g of d.skills) g.items ||= [];
  for (const k of ["github", "cv", "photoAlt", "photoPlaceholder", "githubPlaceholder", "cvPlaceholder", "emailPlaceholder"]) d.profile[k] ??= "";
  d.contact ||= { intro: "" };
  return d;
}

// --- Icons (inline SVG: the CSP blocks external images) ----------------------
const ICONS = {
  linkedin: () => svg("0 0 24 24", [
    ["rect", { x: 3.6, y: 9, width: 3.6, height: 11.4, rx: 0.4, fill: "currentColor" }],
    ["circle", { cx: 5.4, cy: 5.2, r: 2.1, fill: "currentColor" }],
    ["path", { fill: "currentColor", d: "M9.9 9h3.4v1.6c.6-1.1 2-1.9 3.8-1.9 3.2 0 4.3 2 4.3 5.1v6.6H18v-5.8c0-1.5-.4-2.6-1.9-2.6-1.6 0-2.4 1.1-2.4 2.7v5.7H9.9z" }],
  ]),
  // Gmail-style "M" envelope in Google's four brand colours
  email: () => svg("0 0 24 24", [
    ["path", { fill: "#4285F4", d: "M2 7.2v11.1c0 .9.7 1.7 1.6 1.7H6.4V10.6L2 7.2z" }],
    ["path", { fill: "#34A853", d: "M22 7.2v11.1c0 .9-.7 1.7-1.6 1.7h-2.8V10.6L22 7.2z" }],
    ["path", { fill: "#EA4335", d: "M6.4 10.6V6.8L12 11l5.6-4.2v3.8L12 14.8z" }],
    ["path", { fill: "#C5221F", d: "M2 7.2l4.4 3.4V6.8L4.6 5.4C3.5 4.6 2 5.4 2 6.7z" }],
    ["path", { fill: "#FBBC04", d: "M22 7.2l-4.4 3.4V6.8l1.8-1.4c1.1-.8 2.6 0 2.6 1.3z" }],
  ], "icon icon--gmail"),
  cv: () => svg("0 0 24 24", [
    ["path", { fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linejoin": "round", d: "M6.5 3h7.5l4 4v14h-11.5z" }],
    ["path", { fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linejoin": "round", d: "M14 3v4h4" }],
    ["path", { fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round", d: "M9.3 11.5h5.9M9.3 14.5h5.9M9.3 17.5h3.8" }],
  ]),
  // GitHub mark (Octicons "mark-github", MIT licence)
  github: () => svg("0 0 16 16", [
    ["path", { fill: "currentColor", d: "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" }],
  ]),
};

/** Round icon link. External links open in a new tab; mailto: does not. */
function iconLink({ kind, label, path, href, external, extra = {} }) {
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
      iconLink({ kind: "linkedin", label: "LinkedIn profile", path: "profile.linkedin", href: resolveUrl(p.linkedin), external: true }),
      iconLink({ kind: "email", label: `Email ${p.name}`, path: "profile.email", href: p.email ? `mailto:${p.email}` : null, external: false, extra: { "data-url-kind": "email" } }),
      iconLink({ kind: "cv", label: "CV", path: "profile.cv", href: resolveUrl(p.cv), external: true }),
      iconLink({ kind: "github", label: "GitHub profile", path: "profile.github", href: resolveUrl(p.github), external: true })),
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

function projectCard(p, i) {
  const b = `projects.${i}`;
  return el("article", { class: "card project", "data-item": b },
    el("figure", { class: "project__img", "data-img": `${b}.image`, "data-alt": `${b}.imageAlt`, hidden: p.image ? null : "" },
      p.image ? el("img", { src: resolveUrl(p.image), alt: p.imageAlt || "", loading: "lazy" }) : null),
    el("p", { class: "chip", "data-pill": "kind", ...ed(`${b}.kind`) }, p.kind),
    el("h3", ed(`${b}.title`), p.title),
    el("p", { class: "project__meta", ...ed(`${b}.meta`) }, p.meta),
    el("p", { class: "project__summary", ...ed(`${b}.summary`) }, p.summary),
    el("ul", { class: "citations", "data-collection": `${b}.citations`, "data-template": "citation", "data-add-label": "Add citation" },
      p.citations.map((c, j) => el("li", { "data-item": `${b}.citations.${j}` }, el("span", ed(`${b}.citations.${j}`), c)))),
    tagList(`${b}.tags`, p.tags, "tags"),
    linkList(`${b}.links`, p.links),
    badge(`${b}.placeholder`, p.placeholder));
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
    el("div", { class: "grid", "data-collection": "projects", "data-add-label": "Add project" }, d.projects.map(projectCard)),
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
