import type { PageRouteEntry } from "../../../src/server/index";
import * as App from "./root";
import * as contactPage from "./contact.page";
import * as layout from "./layout";
import * as productDetailsPage from "./product-details.page";
import { normalizePageModule } from "../../../src/server/normalize-page-module";

const app = normalizePageModule(App, "root", "__tests__/server/fixtures/root.tsx");
const contact = normalizePageModule(
  contactPage,
  "page",
  "__tests__/server/fixtures/contact.page.tsx",
);
const productDetails = normalizePageModule(
  productDetailsPage,
  "page",
  "__tests__/server/fixtures/product-details.page.tsx",
);
const productsLayout = normalizePageModule(
  layout,
  "layout",
  "__tests__/server/fixtures/layout.tsx",
);

/**
 * The hand-authored mini manifest (the generator arrives in a later slice).
 * Shape per entry mirrors what the real manifest holds: absolute URL — module
 * prefix already composed onto the page's own `route.path` — route name, and
 * the App/Layout/Page triple.
 */
export const routes: PageRouteEntry[] = [
  {
    path: "/contact-us",
    name: "main.contact-us",
    triple: { app, layout: productsLayout, page: contact },
  },
  {
    // `/products` module prefix + the page's declared `/:id`.
    path: "/products/:id",
    name: "products.details",
    triple: { app, layout: productsLayout, page: productDetails },
  },
];
