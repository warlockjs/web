/**
 * The `route` export's accepted shapes: the configured object
 * (`{ path, name } as const`, product-details.page.tsx:6-14) or the bare
 * path string for the 2-line minimum page (contact-us.page.tsx:27, where the
 * name is derived).
 *
 * `route` is about the URL only. What a page ACCEPTS on that URL is declared
 * with the page's top-level `validation` export, not here (`route.validate`
 * was withdrawn after 5.6.0 and is refused at boot). What a page REQUIRES to be
 * reached at all is declared with the page's own top-level `middleware`
 * export, not here.
 */
export type RouteDeclaration =
  | string
  | {
      readonly path: string;
      readonly name?: string;
    };
