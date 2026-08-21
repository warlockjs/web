import type { ReactElement, ReactNode } from "react";
import { Head } from "./head";
import { Scripts } from "./scripts";

export type DefaultAppProps = {
  children: ReactNode;
};

/**
 * The framework's own root, used whenever an app defines no `App.tsx` (or
 * omits a default export). Per Suki's ruling (room seq 1205): "the framework
 * ships a default [App]. The framework's default App is ALSO a full
 * document" — so every page renders a complete `<html>` regardless of
 * whether the app customized its root. Deliberately minimal: an app that
 * needs `lang`/`dir`/providers/its own `<head>` tags writes its own
 * `App.tsx` (`v5/app/src/web/App.tsx` is that example) — this is the
 * framework's fallback, not a design system.
 */
export default function DefaultApp({ children }: DefaultAppProps): ReactElement {
  return (
    <html>
      <head>
        <Head />
      </head>
      <body>
        {/*
          The hydration mount point (documented previously as
          `render-page.ts`'s own hardcoded shell, now moved here since the
          root supplies the whole document itself). An app writing its own
          custom `App.tsx` is responsible for its own equivalent if it wants
          a stable hydration target — this default only covers the
          no-custom-root case.
        */}
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
