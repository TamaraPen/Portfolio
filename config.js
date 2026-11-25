// Site configuration. Contains NO secrets and is safe to be public.
// The owner's GitHub token is never stored in the repository.

export const CONFIG = {
  github: {
    // GitHub username or organisation that owns the repo
    owner: "TamaraPen",
    // The repository that hosts this site
    repo: "Portfolio",
    // Branch that GitHub Pages publishes from
    branch: "main",
  },
  // Site content file (relative to index.html)
  dataPath: "data.json",
  // Where uploaded photos/documents are committed
  uploadDir: "assets/uploads",
  // Per-file upload cap (MB). Keeps commits fast and the repo small.
  maxUploadMB: 5,
};
