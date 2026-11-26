// Minimal modal dialog + toast built on the native <dialog> element (no libraries).
// Used only by the owner tools, but harmless for visitors.

import { el, uid } from "./util.js";

/**
 * Open a modal form.
 *   fields: [{ name, label, type?: "text"|"password"|"textarea"|"file"|"select", value?, accept?, multiple?, options?: [[value, label]], help? }]
 *   (a file field with multiple: true yields an array of Files; otherwise one File or null)
 *   onSubmit(values): may be async; throw an Error to show a message and keep the dialog open.
 * Resolves with onSubmit's return value (or the values), or null if cancelled.
 */
export function openDialog({ title, intro, fields = [], confirmLabel = "OK", cancelLabel = "Cancel", onSubmit }) {
  return new Promise((resolve) => {
    const titleId = uid();
    const dlg = el("dialog", { class: "dlg", "aria-labelledby": titleId });
    const err = el("p", { class: "dlg__err", role: "alert", hidden: "" });
    const inputs = {};
    let result = null;

    const rows = fields.map((f) => {
      const id = uid();
      let input;
      if (f.type === "textarea") input = el("textarea", { id, rows: 3 });
      else if (f.type === "select") input = el("select", { id }, (f.options || []).map(([value, label]) => el("option", { value }, label)));
      else if (f.type === "file") input = el("input", { id, type: "file", accept: f.accept || null, multiple: f.multiple ? "" : null });
      else input = el("input", { id, type: f.type || "text", autocomplete: "off", spellcheck: f.type === "password" ? "false" : null });
      if (f.value != null && f.type !== "file") input.value = f.value;
      inputs[f.name] = input;
      return el("div", { class: "dlg__row" }, el("label", { for: id }, f.label), input, f.help ? el("small", {}, f.help) : null);
    });

    const ok = el("button", { type: "button", class: "btn", onclick: submit }, confirmLabel);
    const cancel = el("button", { type: "button", class: "btn btn--ghost", onclick: () => dlg.close() }, cancelLabel);

    dlg.append(
      el("h2", { id: titleId }, title),
      intro ? el("p", { class: "dlg__intro" }, intro) : null,
      err,
      ...rows,
      el("div", { class: "dlg__actions" }, cancel, ok),
    );
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "file") { e.preventDefault(); submit(); }
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    (Object.values(inputs)[0] || ok).focus();

    async function submit() {
      const values = {};
      for (const [name, input] of Object.entries(inputs)) {
        values[name] = input.type === "file" ? (input.multiple ? [...input.files] : input.files[0] || null) : input.value.trim();
      }
      ok.disabled = true;
      err.hidden = true;
      try {
        result = onSubmit ? await onSubmit(values) : values;
        if (result === null || result === undefined) result = true;
        dlg.close();
      } catch (e) {
        err.textContent = e.message || String(e);
        err.hidden = false;
        ok.disabled = false;
      }
    }
  });
}

/** Yes/no confirmation. Resolves true/false. */
export async function confirmDialog(message, confirmLabel = "Confirm") {
  const r = await openDialog({ title: "Please confirm", intro: message, confirmLabel });
  return r !== null; // null means cancelled / closed with Esc
}

/**
 * Several-way choice, e.g. Save and exit / Discard and exit / Cancel.
 *   choices: [{ label, value, kind?: "primary"|"danger"|"ghost" }]
 * Resolves with the chosen value, or null if closed (Esc).
 */
export function choiceDialog({ title, intro, choices }) {
  return new Promise((resolve) => {
    const titleId = uid();
    let result = null;
    const dlg = el("dialog", { class: "dlg", "aria-labelledby": titleId });
    const buttons = choices.map((c) => el("button", {
      type: "button",
      class: c.kind === "primary" ? "btn" : c.kind === "danger" ? "btn btn--danger" : "btn btn--ghost",
      "data-choice": String(c.value),
      onclick: () => { result = c.value; dlg.close(); },
    }, c.label));
    dlg.append(
      el("h2", { id: titleId }, title),
      intro ? el("p", { class: "dlg__intro" }, intro) : null,
      el("div", { class: "dlg__actions dlg__actions--wrap" }, buttons),
    );
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    (buttons.find((b, i) => choices[i].kind === "primary") || buttons[0]).focus();
  });
}

let toastTimer;
/** Short status message at the bottom of the screen. */
export function toast(message, kind = "info") {
  document.querySelector(".toast")?.remove();
  const t = el("div", { class: `toast${kind === "error" ? " toast--error" : ""}`, role: "status" }, message);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === "error" ? 12000 : 6000);
}
