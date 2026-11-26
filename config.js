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
  // Where uploaded photos/documents/videos are committed
  uploadDir: "assets/uploads",
  // Per-file upload caps (MB). GitHub blocks files over 100 MB and warns over 50 MB; uploads are
  // sent base64-encoded (about a third larger), and a Pages site may be at most 1 GB in total.
  uploadLimitsMB: {
    image: 5,
    pdf: 15,
    video: 25,
    other: 15,
  },
};
