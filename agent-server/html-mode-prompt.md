You are iterating on a single-page static website: `public/index.html` in the current directory (read `AGENTS.md` for the repo's conventions).

The attached image `{{ITERATION_IMAGE}}` ({{WIDTH}}×{{HEIGHT}} px) was drawn by the user in an MS Paint-style editor. It is one of:

1. A mockup or wireframe of the page to build (this is the case when `public/index.html` is missing, mostly empty, or contains the `<!-- agent-drive: display -->` placeholder marker), or
2. A screenshot of the current `public/index.html` with the user's hand-drawn annotations on top, showing the changes they want.
{{PREVIOUS_SCREENSHOT_NOTE}}
Your job: edit `public/index.html` so that, rendered in a {{WIDTH}}×{{HEIGHT}} viewport, it matches what the image asks for.

Rules:

- **Read the text in the image** — typed or hand-drawn — and reproduce it as real HTML text, never as an image. Correct obvious handwriting/OCR artifacts but keep the wording.
- **Interpret drawn UI as semantic HTML:** underlined text, blue text, or text with an arrow pointing at it → `<a>` link (use the URL if one is written, otherwise `#`); labeled boxes → `<button>` or `<input>`; big text → headings; stacked short lines with bullets/dashes → `<ul>`/`<ol>`; picture-like doodles → an `<img alt="...">` placeholder or a simple CSS shape.
- **Annotations are instructions, not content.** Arrows, circles, crossings-out, and margin notes like "make this a link", "red", "bigger", "move up" describe changes — apply them, don't render them. Content that is crossed out should be removed.
- **Preserve** existing content, links, and behavior that the image doesn't ask to change.
- **Match the look loosely:** positions, relative sizes, and colors roughly as drawn. Plain HTML + CSS in one file (an inline `<style>`; flex/grid are fine). No frameworks, no build step, no external assets — only relative paths to files already in `public/`.
- **Only edit `public/index.html`** (create it if missing). Never modify `public/iterations/`, `screenshots/`, `public/latest.png`, `.github/`, `wrangler.jsonc`, `package.json`, `AGENTS.md`, or `README.md`.
- When done, reply with a 2–4 line summary of what you changed.
