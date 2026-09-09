# Site repo conventions

(Managed by the jspaint fork: `agent-server/site-template/AGENTS.md` — edit it there.)

This repository is a one-page static website driven from JS Paint via the Agent Drive server. You will be asked to edit it based on an attached image.

- **The page is `public/index.html`.** Keep everything — markup, CSS, any tiny script — inline in that single file. No build step, no frameworks.
- **Only edit `public/index.html`.** Create it if it's missing.
- `public/iterations/NNN.png` are the user's drawings and annotated screenshots — the *instructions* for each change. `public/latest.png` is a copy of the newest one. Never edit, move, or delete them; don't reference them from the page unless the user asks for an image.
- `screenshots/` holds renders of the page (gitignored). Don't touch it.
- Don't install packages, set up Python environments, or launch browsers to inspect or verify — just read the attached image(s) and write the HTML. The user sees a render of your result immediately in JS Paint.
- Don't touch `.github/`, `live/`, `wrangler.jsonc`, `package.json`, `AGENTS.md`, or `README.md` — they're generated from the jspaint fork.
- If `public/index.html` contains `<!-- agent-drive: display -->`, it's a placeholder that just shows `latest.png`. Replace it entirely with real HTML that reproduces the drawing's content.
- Use relative paths only; `public/` is deployed as-is to Cloudflare, so anything you reference must exist in `public/`.
- Text in the image is content: render it as real, selectable HTML text (never as an image), correcting obvious handwriting artifacts.
