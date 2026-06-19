# reviewjs

**A drop-in visual review & annotation layer for any website.** Highlight text,
draw rectangles & circles, drop pins, sketch freehand and leave threaded
comments — directly on top of your live page.

No backend. No database. No tracking. Comments live in the visitor's own
browser (`localStorage`) and can be **downloaded to / imported from a portable
JSON file** to share with your team.

```html
<script src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js" defer></script>
```

That single line is the whole installation.

---

## Why reviewjs?

- **One `<script>` tag.** No build step, no framework, no signup.
- **Works everywhere.** Plain HTML, React, Vue, Svelte, WordPress, Webflow,
  Shopify, static sites — anything that renders HTML in a browser.
- **Local-first & private.** Every comment is stored on the reviewer's device.
  Nothing is sent anywhere.
- **Portable.** Reviewers export their feedback as JSON and send it to you; you
  import it with one click and see every note in place.
- **Polished UI.** A floating toolbar, a Figma-style comments panel, light/dark
  themes that auto-adapt to your page, and full keyboard shortcuts.
- **Tiny & dependency-free.** ~40 KB of vanilla JavaScript, zero dependencies.

---

## Features

| Tool | What it does |
|------|--------------|
| ✏️ **Highlight** | Select any text to highlight and comment on it |
| ▭ **Rectangle** | Draw a box around any region |
| ◯ **Circle** | Circle anything that needs attention |
| 📍 **Pin** | Drop a point marker anywhere |
| 〰️ **Freehand** | Sketch directly on the page |
| ➕ **Section note** | Hover any paragraph/heading for a margin comment button |

Plus: threaded replies, resolve/reopen, search & filter, deep-links to a single
comment (`#an=<id>`), an "off" mode that collapses to a small launcher, and a
**Download / Import** round-trip for sharing.

---

## Quick start

### 1. The fastest way (CDN)

Add this just before `</body>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js" defer></script>
```

That's it — reload the page and the toolbar appears in the bottom-right corner.

> **Pin a version** for production stability:
> `https://cdn.jsdelivr.net/npm/@reviewjs/annotate@1.0.1/annotate.js`
>
> unpkg works too:
> `https://unpkg.com/@reviewjs/annotate@1.0.1/annotate.js`

### 2. Self-hosted

Download [`annotate.js`](./annotate.js), drop it next to your HTML and:

```html
<script src="/annotate.js" defer></script>
```

---

## Configuration

Configure with `data-` attributes on the script tag — all optional:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js"
  data-project="marketing-site"
  data-accent="#6d28d9"
  data-theme="auto"
  data-position="bottom-right"
  data-note="Focus on the hero copy and pricing — flag anything off-brand."
  data-share-email="reviews@example.com"
  defer
></script>
```

| Attribute | Default | Description |
|-----------|---------|-------------|
| `data-project` | `""` | Namespace for stored comments. Keep separate sites apart. |
| `data-page` | `location.pathname` | Page key comments are grouped under. |
| `data-accent` | — | Brand color for primary buttons & the active tool. |
| `data-theme` | `auto` | `light`, `dark`, or `auto` (sniffs your page background). |
| `data-position` | `bottom-right` | `bottom-right` or `bottom-left`. |
| `data-blocks` | sensible default | CSS selector for "section note" (+) targets. |
| `data-note` | — | Author's note to reviewers — what should be reviewed. Shown when they start and atop the comments panel. |
| `data-share-email` | — | Where reviewers send comments: an email address, or a Slack / Hangout link. Adds a **Share** button. |

Prefer JS config? Set `window.AnnotateConfig` **before** the script loads:

```html
<script>
  window.AnnotateConfig = {
    project: "marketing-site",
    accent: "#6d28d9",
    theme: "auto",
    note: "Focus on the hero copy and pricing — flag anything off-brand.",
    shareEmail: "reviews@example.com",
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js" defer></script>
```

---

## Framework integration

reviewjs is a plain browser script, so the goal everywhere is the same:
**load `annotate.js` once, after the page has rendered.** Below are copy-paste
recipes.

### ⚛️ React (and Next.js)

Load it once at the app root with a `useEffect`:

```jsx
// components/Annotate.jsx
import { useEffect } from "react";

export default function Annotate() {
  useEffect(() => {
    if (document.getElementById("annotate-js")) return;
    window.AnnotateConfig = { project: "my-react-app", accent: "#6d28d9" };
    const s = document.createElement("script");
    s.id = "annotate-js";
    s.src = "https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js";
    s.defer = true;
    document.body.appendChild(s);
  }, []);
  return null;
}
```

```jsx
// App.jsx
import Annotate from "./components/Annotate";

export default function App() {
  return (
    <>
      <Annotate />
      {/* your app */}
    </>
  );
}
```

**Next.js (App Router)** — drop the `<Script>` into `app/layout.js`:

```jsx
import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script
          src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
```

### 🟩 Vue 3

```vue
<!-- App.vue -->
<script setup>
import { onMounted } from "vue";

onMounted(() => {
  if (document.getElementById("annotate-js")) return;
  window.AnnotateConfig = { project: "my-vue-app", accent: "#10b981" };
  const s = document.createElement("script");
  s.id = "annotate-js";
  s.src = "https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js";
  s.defer = true;
  document.body.appendChild(s);
});
</script>
```

Or, even simpler, add the `<script>` tag straight into `public/index.html`
(Vue CLI) / `index.html` (Vite) before `</body>`.

### 🧩 WordPress

**Option A — no code.** Install a "header/footer scripts" plugin (e.g. *WPCode*
or *Insert Headers and Footers*) and paste this into the **footer** box:

```html
<script src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js" data-project="my-wp-site" defer></script>
```

**Option B — theme code.** Add to your theme's `functions.php`:

```php
function reviewjs_enqueue() {
  wp_enqueue_script(
    'reviewjs',
    'https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js',
    array(),
    '1.0.1',
    true // load in footer
  );
}
add_action( 'wp_enqueue_scripts', 'reviewjs_enqueue' );
```

> Tip: wrap the enqueue in `if ( current_user_can('edit_posts') )` to show the
> review tools only to logged-in editors.

### 🔷 Svelte / SvelteKit

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { onMount } from "svelte";
  onMount(() => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js";
    s.defer = true;
    document.body.appendChild(s);
  });
</script>

<slot />
```

### 🅰️ Angular

In `angular.json`, add to the `"scripts"` array:

```json
"scripts": [
  "https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js"
]
```

### 🌐 Plain HTML / static sites / Webflow / Shopify / Squarespace

Paste before `</body>` (or into the platform's "custom code / footer" field):

```html
<script src="https://cdn.jsdelivr.net/npm/@reviewjs/annotate/annotate.js" defer></script>
```

---

## Sharing comments

Because everything is local, sharing is an explicit, privacy-friendly action:

1. A reviewer opens the **Comments panel** (toolbar list icon or press `A`).
2. They click **Download** (⬇) to save a `annotate-<page>-<date>.json` file.
3. They send you that file.
4. You open the same page, click **Import** (⬆), pick the file — every comment
   reappears anchored in place.

You can also drive this from code (see the API below).

---

## JavaScript API

A global `window.Annotate` is available once the script loads:

```js
Annotate.open();              // show the review layer and open the comments panel
Annotate.close();
Annotate.toggle();
Annotate.enable();            // show the review layer
Annotate.disable();           // collapse to the launcher
Annotate.setTool("highlight");// show the layer, then choose cursor | highlight | rect | circle | pen | pin
Annotate.comments();          // → array of comment objects for this page
Annotate.focus(id);           // scroll to & highlight a comment
Annotate.export();            // trigger the JSON download
Annotate.import();            // open the file picker
Annotate.clear();             // delete all comments on this page (local)
Annotate.toast("Saved!");     // show a toast
Annotate.version;             // "1.0.1"
```

### Comment shape

```json
{
  "id": "c…",
  "page": "marketing-site:/pricing",
  "url": "https://example.com/pricing",
  "type": "highlight",
  "author": "Jane Doe",
  "text": "This price looks out of date.",
  "color": "#f59e0b",
  "anchor": { "exact": "…", "prefix": "…", "suffix": "…" },
  "geom": null,
  "resolved": false,
  "replies": [],
  "createdAt": "2026-06-16T10:00:00.000Z",
  "updatedAt": "2026-06-16T10:00:00.000Z"
}
```

---

## Keyboard shortcuts

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `V` | Browse | `P` | Pin |
| `H` | Highlight | `A` | Comments panel |
| `R` | Rectangle | `O` | Show / hide tools |
| `C` | Circle | `Esc` | Cancel |
| `D` | Freehand | `?` | Shortcuts card |

---

## Try it locally

```bash
git clone git@github.com:reviewjs/annotate.git
cd annotate
npm start          # serves the demo at http://localhost:3000
```

Open [`index.html`](./index.html) and start annotating. Framework examples live
in [`examples/`](./examples).

---

## Browser support

Modern evergreen browsers (Chrome, Edge, Firefox, Safari). Uses standard DOM
APIs only — no polyfills required. Gracefully no-ops where `localStorage` is
unavailable (private mode, sandboxed iframes).

---

## License

[MIT](./LICENSE) — free for personal and commercial use.
