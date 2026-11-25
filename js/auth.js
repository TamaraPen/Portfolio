// Owner sign-in. Loaded only when someone clicks the pencil button (#owner-login) in the
// top bar, or when this tab's session already has a token.
//
// How "authentication" works on a static site: there is no server to check a password.
// The real gate is GitHub. The owner pastes a fine-grained personal access token that has
// write access to THIS repository only. Without it, GitHub refuses every write, so nothing
// in this page can give a visitor write access. The token is kept in sessionStorage
// (this tab only, cleared when the tab closes) and is never written to the repo.

import { CONFIG } from "../config.js";
import { TOKEN_KEY } from "./util.js";
import { openDialog } from "./dialog.js";
import { verifyToken } from "./github.js";

export function isConfigured() {
  const g = CONFIG.github;
  return g.owner && !g.owner.startsWith("YOUR-") && g.repo;
}

/** Shows the sign-in dialog. Resolves with a verified token, or null if cancelled. */
export async function promptLogin() {
  if (!isConfigured()) {
    await openDialog({
      title: "Owner login not set up yet",
      intro: "Open config.js and set github.owner and github.repo to your GitHub username and repository name, then reload.",
      confirmLabel: "OK",
    });
    return null;
  }
  const result = await openDialog({
    title: "Owner sign-in",
    intro: `Paste a fine-grained GitHub token with "Contents: Read and write" access to ${CONFIG.github.owner}/${CONFIG.github.repo}. It stays in this tab only.`,
    fields: [{ name: "token", label: "GitHub token", type: "password" }],
    confirmLabel: "Sign in",
    onSubmit: async ({ token }) => {
      if (!token) throw new Error("Enter your token.");
      await verifyToken(token, CONFIG.github);
      return token;
    },
  });
  if (typeof result === "string") {
    sessionStorage.setItem(TOKEN_KEY, result);
    return result;
  }
  return null;
}

/** Re-validates a token saved earlier in this tab. Returns it, or null (and forgets it) if invalid. */
export async function restoreSession() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token || !isConfigured()) return null;
  try {
    await verifyToken(token, CONFIG.github);
    return token;
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

export function signOut() {
  sessionStorage.removeItem(TOKEN_KEY);
}
