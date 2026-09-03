/**
 * The framework fallback 404 document's stylesheet, duplicated here as a
 * plain string constant.
 *
 * `framework-default-not-found.css` remains the source of truth for this
 * stylesheet's content — this file is a build-time necessity, not a second
 * design surface. The production server build refuses to compile
 * static-asset imports (`?raw`, `?url`, `import.meta.url`) in the page
 * graph, and says so in its own diagnostic: see the `REMEDY` text in
 * `../build/generate-pages-barrel.ts`. `not-found-page.ts` is part of that
 * server build, so it cannot import the `.css` file directly and must read
 * its text from a plain module instead.
 *
 * `not-found-page-stylesheet.spec.ts` asserts this constant stays
 * byte-identical to the `.css` file, so a future edit to one cannot silently
 * drift from the other.
 */
export const FRAMEWORK_DEFAULT_NOT_FOUND_STYLESHEET = `:root {
  color-scheme: light dark;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-block-size: 100vh;
  display: grid;
  place-items: center;
  padding-block: 2rem;
  padding-inline: 1.5rem;
  background: #fafafa;
  color: #18181b;
  font-family: system-ui, sans-serif;
}

main {
  inline-size: min(100%, 34rem);
  text-align: center;
}

.rule {
  block-size: 1px;
  inline-size: 3rem;
  margin-block: 0 1.5rem;
  margin-inline: auto;
  background: #facc15;
}

h1 {
  margin: 0;
  font-size: clamp(4rem, 16vw, 7rem);
  font-weight: 700;
  letter-spacing: -0.06em;
  line-height: 1;
}

p {
  margin: 1.25rem 0 0;
  color: #52525b;
  font-size: 1rem;
  line-height: 1.5;
}

a {
  display: inline-block;
  margin-block-start: 1.5rem;
  color: inherit;
  text-underline-offset: 0.2em;
}

a:focus-visible {
  outline: 2px solid #facc15;
  outline-offset: 4px;
}

@media (prefers-color-scheme: dark) {
  body {
    background: #18181b;
    color: #fafafa;
  }

  p {
    color: #d4d4d8;
  }
}
`;

/**
 * Build the `data:text/css` URL the fallback document's `<link>` points at.
 *
 * Base64-encoded so the CSS's own characters (`"`, `<`, newlines) never need
 * escaping for use inside an HTML attribute.
 */
export function buildFrameworkDefaultNotFoundStylesheetUrl(): string {
  const base64 = Buffer.from(FRAMEWORK_DEFAULT_NOT_FOUND_STYLESHEET, "utf8").toString("base64");

  return `data:text/css;base64,${base64}`;
}
