# MR Drumset — Presentation

A slide deck in the style of PowerPoint, rendered as a static website
using [Reveal.js](https://revealjs.com) (loaded from CDN — no build
step, no install).

## Viewing

Any of these work:

### Option 1 — just open the file

Double-click `index.html`, or drag it into a browser. Reveal.js loads
from CDN, so an internet connection is needed the first time.

### Option 2 — serve it locally

Any static file server will do. For example:

```bash
# from the repo root
npx serve presentation
# or
python3 -m http.server --directory presentation 8080
```

Then open `http://localhost:8080`.

### Option 3 — while the main project is running

`npm start` already runs a Vite dev server. You can add the
presentation folder to Vite's public dir, or just open
`presentation/index.html` directly in another tab.

## Navigation

| Keys                | Action                       |
|---------------------|------------------------------|
| `→` / `Space`       | next slide                   |
| `←`                 | previous slide               |
| `↑` / `↓`           | vertical slides (none here)  |
| `F`                 | fullscreen                   |
| `S`                 | speaker-notes view           |
| `Esc` / `O`         | slide overview               |
| `?`                 | show help                    |

## Structure

- `index.html` — slide content (one `<section>` per slide)
- `style.css` — custom theme overrides (dark, tri-accent palette for
  the three pillars: WebXR/WebGL/Pure Data)
- Reveal.js 5.1 is loaded from jsDelivr CDN; no `node_modules`

## Editing a slide

Each slide is a `<section>` in `index.html`. To add a new slide,
insert a new `<section>` between two existing ones. To style code
blocks, use `<pre><code class="language-js">...</code></pre>` and
highlight.js will colour the syntax automatically.

## Exporting to PDF

Reveal.js supports PDF export via the browser:

1. Open `index.html?print-pdf` (note the query string)
2. Browser print dialog → "Save as PDF"
3. Use "Landscape", no headers/footers, 0 margins

Result: one slide per page.
