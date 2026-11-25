// GitHub REST API calls used for owner sign-in and saving.
// Docs (check these if anything stops working):
//   https://docs.github.com/en/rest/git/blobs · /git/trees · /git/commits · /git/refs
//   Fine-grained token permission needed: "Contents: Read and write" on the single repo.

const API = "https://api.github.com";

async function gh(token, path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.json()).message || message; } catch { /* ignore */ }
    const hints = {
      401: "The token was rejected (wrong, expired or revoked).",
      403: "The token is not allowed to do this (check it has Contents: Read and write).",
      404: "Repository or branch not found, or the token cannot access it.",
      409: "The branch changed while saving. Try again.",
      422: "GitHub rejected the request. Try again.",
    };
    const err = new Error(`GitHub ${res.status}: ${message}${hints[res.status] ? ` — ${hints[res.status]}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const repoPath = ({ owner, repo }) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const branchRef = (branch) => branch.split("/").map(encodeURIComponent).join("/");

/** Confirms the token is valid, can see the repo, and (when reported) can push. */
export async function verifyToken(token, cfg) {
  const repo = await gh(token, repoPath(cfg));
  if (repo.permissions && repo.permissions.push === false) {
    throw new Error("This token can read the repository but cannot write to it. Create a token with Contents: Read and write.");
  }
  return repo;
}

/** Latest data.json straight from the branch (not the Pages copy, which can lag a few minutes). */
export async function fetchRemoteData(token, cfg, dataPath) {
  const url = `${API}${repoPath(cfg)}/contents/${dataPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.raw+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} while reading ${dataPath}`);
  return JSON.parse(await res.text());
}

/**
 * Commit several files in ONE commit (so GitHub Pages runs one build per save).
 * files: [{ path, base64 }]
 */
export async function commitFiles(token, cfg, files, message) {
  const base = repoPath(cfg);
  const ref = await gh(token, `${base}/git/ref/heads/${branchRef(cfg.branch)}`);
  const headSha = ref.object.sha;
  const head = await gh(token, `${base}/git/commits/${headSha}`);

  const tree = [];
  for (const f of files) {
    // Requests are sent one after another (GitHub advises against parallel writes).
    const blob = await gh(token, `${base}/git/blobs`, { method: "POST", body: { content: f.base64, encoding: "base64" } });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh(token, `${base}/git/trees`, { method: "POST", body: { base_tree: head.tree.sha, tree } });
  const commit = await gh(token, `${base}/git/commits`, { method: "POST", body: { message, tree: newTree.sha, parents: [headSha] } });
  // force defaults to false: the update is refused if someone else committed in between.
  await gh(token, `${base}/git/refs/heads/${branchRef(cfg.branch)}`, { method: "PATCH", body: { sha: commit.sha } });
  return commit.sha;
}
