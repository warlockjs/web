import type { ReactElement, ReactNode } from "react";
import { useDocumentContext } from "./document-context";
import { Head } from "./head";
import { Scripts } from "./scripts";

export type DefaultAppProps = {
  children: ReactNode;
};

/**
 * The framework's own root, used whenever an app defines no `root.tsx` (or
 * omits a default export). The framework's default App is ALSO a full
 * document — so every page renders a complete `<html>` regardless of
 * whether the app customized its root. The app owns the document: when a
 * custom `root.tsx` exists (`v5/app/src/web/root.tsx` is that example), it is
 * fully responsible for `lang`/`dir`/`<Scripts nonce>`/providers/its own
 * `<head>` tags. Only when no custom App exists does this fallback supply
 * `lang`/`dir`/nonce itself, sourced from the framework's document-context
 * slots rather than any app-owned data.
 */
export default function DefaultApp({ children }: DefaultAppProps): ReactElement {
  const { lang, dir } = useDocumentContext("DefaultApp");

  return (
    <html lang={lang} dir={dir}>
      <head>
        <Head />
      </head>
      <body>
        {/*
          The hydration mount point (documented previously as
          `render-page.ts`'s own hardcoded shell, now moved here since the
          root supplies the whole document itself). An app writing its own
          custom `root.tsx` is responsible for its own equivalent if it wants
          a stable hydration target — this default only covers the
          no-custom-root case.
        */}
        <div id="root">{children}</div>
        {/* Prop-less: inherits the nonce slot via Scripts' own fallback
            (scripts.ts) rather than reading document-context twice here. */}
        <Scripts />
      </body>
    </html>
  );
}
