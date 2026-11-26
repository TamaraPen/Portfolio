# Tamara Pen — portfolio (static site for GitHub Pages)

Single-page portfolio with an owner-only on-page editor. No server, no build step, no libraries.

## Pinned environment

| Item | Version / note |
|---|---|
| Languages | HTML5, CSS3, vanilla JavaScript (ES2022 modules) |
| Libraries / frameworks | None |
| Build step / Node | None. (Node 22 and Python 3.13 were used only for local checks, not needed to run the site) |
| Browsers | Current Chrome, Edge, Safari, Firefox (needs `<dialog>`, ES modules, `contenteditable`) |
| External requests | Google Fonts (optional; falls back to system fonts) and `api.github.com` (owner sign-in/save only) |
| GitHub REST API | `X-GitHub-Api-Version: 2022-11-28` |

Recommended editor: **VS Code + the Live Server extension** (right-click `index.html` → *Open with Live Server*). Opening `index.html` by double-click will not work, because browsers block `fetch("data.json")` from `file://`. `python3 -m http.server` in this folder also works.

## Files

```
index.html          page shell + nav + Content-Security-Policy
css/styles.css      all styling
config.js           GitHub owner/repo/branch (no secrets)  ← edit this
data.json           ALL site content (edited by the owner via the page)
js/main.js          visitor entry point (read-only)
js/render.js        draws the page from data.json (text set safely, no innerHTML)
js/auth.js          owner sign-in (loaded only on demand)
js/editor.js        edit mode, save, export (loaded only after sign-in)
js/viewer.js        project media viewer + lightbox (display code)
assets/icons/       Gmail and CV button artwork
tests/e2e.py        end-to-end checks: python3 -I tests/e2e.py (needs Google Chrome)
js/github.js        GitHub API calls
js/dialog.js, util.js, state.js
assets/uploads/     photos/documents uploaded by the owner end up here
.nojekyll           tells Pages to serve files as-is
```

## Deploy to GitHub Pages

1. Create a **public** repository, e.g. `tamara-pen-portfolio` (GitHub Pages on free plans requires public repos; private repos need a paid plan).
2. Upload everything in this folder to the repo root on branch `main`.
3. Edit `config.js`: set `github.owner` to the GitHub username and `github.repo` to the repo name; commit.
4. Repo → **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)` → Save.
5. After a minute or two the site is live at `https://<owner>.github.io/<repo>/`.

## Create the owner token (once)

GitHub → profile menu → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

- Resource owner: the account that owns the repo
- Expiration: short (e.g. 30–90 days); regenerate when it expires
- Repository access: **Only select repositories** → this repo only
- Repository permissions: **Contents: Read and write** (Metadata: read is added automatically). Nothing else.

Copy the token once; store it in a password manager. *(GitHub's menus change occasionally; if a label differs, check GitHub's current "Managing your personal access tokens" documentation.)*

## Using the editor

1. Open the live site → click the round **pencil** button in the top-right corner (tooltip: "sign in to edit") → paste the token. It is checked against GitHub (valid, and allowed to write to this repo).
2. Edit mode starts only when you click the pencil (a page refresh never starts it): every piece of text becomes a field, and a bar with Save / Export / Log out appears at the bottom. The pencil turns into a red **EXIT** button. EXIT leaves edit mode but keeps you signed in for this tab (it asks Save / Discard / Cancel if there are unsaved changes); the pencil brings you back. You can then:
   - click any text and type (bio, headings, jobs, education, project/document notes, contact details);
   - **Add/Replace photo** (profile photo, project images);
   - **+ Add tag** / ✕ on skill tags and project tags;
   - **Add project / Add document** and **Remove** on each card; **+ Add link or file** on a project (web link or uploaded file);
   - **Edit link** next to documents and LinkedIn to set a web address or upload a file;
   - **Dismiss tag** on a yellow *Placeholder* badge once the real content is in.
3. **Save changes** commits `data.json` plus any new uploads to GitHub in **one commit**. Visitors see the update when Pages finishes publishing (usually a few minutes).
4. **Export JSON** downloads a backup of `data.json` (uploaded files already live in `assets/uploads/` in the repo).
5. **Log out** clears the token. Closing the tab also clears it.

Limits (`config.js` → `uploadLimitsMB`): images 5 MB, PDFs 15 MB, videos (mp4/webm) 25 MB, other documents 15 MB. Longer videos: upload to YouTube as "Unlisted" and paste the link. Images png/jpg/webp/gif; documents pdf/docx/pptx/xlsx/csv/txt/md/json/zip. SVG and executables are refused. GitHub blocks files over 100 MB and the whole Pages site must stay under 1 GB.

**Sections and blocks** (edit mode): everything below the Overview is a list of sections in `data.json` (`sections`), each made of blocks: text, project, gallery, entry list, tag list, icon-button row, documents list. Use **Add section** (bottom of the page) and **Add block** (inside a section). Drag the ⠿ handle to move sections, blocks, dropdown rows and media items (mouse or touch), or use the ↑ ↓ / ← → buttons. The navigation follows the section order. Deleting a section asks first. Changes are saved with **Save changes** as usual.

**Project panels**: title, media viewer (left) and dropdown rows (right, all closed until clicked). Rows with no text are hidden from visitors. "View full documents" appears when a project has documents; PDFs and images open full screen.

**Project media** (edit mode → a project's viewer → **Add media**): one image; several images at once (becomes a slide deck you can reorder); one video; one PDF; or a YouTube/Vimeo link (shown via youtube-nocookie.com / player.vimeo.com). PowerPoint files can't be shown in a browser: export them as PDF or as slide images first. On phones, PDFs open full size in the browser's own viewer (embedded PDFs on iPhone only show the first page).

## How auth and saving really work on a static host

There is no server to check a password. A username/password check written in browser JavaScript would not be security: anyone can read the code or edit the page in dev tools and skip it. So **GitHub is the gatekeeper**:

- Editing is allowed only to someone holding a token that GitHub accepts for write access to this repo.
- Visitors never receive edit code: `editor.js`, `auth.js`, `github.js` are not even requested until a valid token is entered (verified in tests). The files are public in the repo, but they cannot do anything without the token.
- Saving = GitHub Git Data API (blobs → tree → commit → fast-forward ref update), one commit per save, so Pages runs one build per save (Pages has a soft limit of 10 builds/hour).
- While signed in, the editor loads `data.json` from the branch via the API (not the Pages copy, which can lag) so a quick reload can't overwrite a newer save.

### Security trade-offs (read these)

- **The token is stored in `sessionStorage`** (this tab only) while signed in. Any script running on the page could read it. Mitigations used: a strict Content-Security-Policy (no inline scripts, no third-party scripts), all content rendered as text (no `innerHTML`), URL scheme allow-list, no SVG uploads. Still: only sign in on a trusted computer, and log out when done.
- A token with *Contents: write* could change **any file in the repo, including the JavaScript**. Keep it scoped to this one repo, give it a short expiry, and revoke it in GitHub settings if it may have leaked. Protect the GitHub account with 2FA.
- **Everything is public.** The repo, `data.json` and every uploaded file are readable by anyone. Do not upload confidential protocols, unpublished data, or personal documents. Removing a file from the site does not remove it from the repo's git history.
- Removed items/uploads: deleting an upload reference from the page does not delete the file from `assets/uploads/` (delete it in GitHub if needed).
- The contact section is a mailto link, because a working contact form needs a backend.

### Simpler/better alternatives (not built)

- **Edit `data.json` directly on github.com** (pencil icon, then commit). No token handling in the browser at all, and safest, but not friendly for non-technical editing.
- **A git-based CMS** (e.g. Decap CMS) gives a nicer editor but needs an OAuth proxy or similar external service, and was out of scope.
- **A small serverless function** (e.g. Cloudflare Worker) holding the token server-side and checking a real login would keep the token out of the browser. It adds a backend, so it was out of scope.

The specified approach (owner edits on page, saved by committing JSON through the GitHub API) does work on a public static site, so it was built. One deliberate change: sign-in is the **GitHub token only**, with no separate username/password screen, as agreed.

## Placeholders to replace

Items needing real content show a yellow **Placeholder** badge on the page (dismiss it in edit mode), and are listed under `_placeholders` in `data.json`:

- Contact email (`tamara.pen@example.com` is a stand-in)
- Profile photo (initials avatar shown)
- All four documents (no files attached yet)
- Project "Collaborative research presentation" (CRWAD 2025; title/role not on LinkedIn)
- Project "Plate-assay data analysis summary" and the sample SOP (illustrative entries)
- `config.js` → `owner` / `repo`

Real content came from Tamara's LinkedIn (About, experience, education, skills, conference posts); project summaries are paraphrased from those posts. Please have her review wording, dates and the skills grouping.

## What was verified

- `data.json` parses; every JS file passes `node --check`.
- Headless Chromium end-to-end test (41 checks, GitHub API mocked): visitors get no owner bar, no editable fields, no edit-code requests and no GitHub traffic; wrong token is rejected and still shows no controls; correct token shows the bar; inline edits, tag add/remove, project/document add/remove (with confirm), photo/file uploads, disallowed file types and `javascript:` URLs refused; Save sends one commit (data.json + uploads) ending in a fast-forward ref update; JSON export; log out removes everything; hostile data (`<script>`, `javascript:` links) renders as inert text; all five jump links scroll to their sections; no horizontal overflow at 390 px and 1200 px.
- **Not verified against the real GitHub API** (the test mocks it): do one real save after setup and check the commit appears. Also confirm in current GitHub docs that your token UI/permission names match the steps above.
