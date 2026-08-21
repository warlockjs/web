import type { PageRouteEntry } from "../../../src/server/index";
import * as App from "./App";
import * as contactPage from "./contact.page";
import * as layout from "./layout";
import * as productDetailsPage from "./product-details.page";

/**
 * The hand-authored mini manifest (spike-criteria P6 precedent — the
 * generator arrives in a later slice). Shape per entry mirrors what the real
 * manifest holds (design/request-lifecycle.md:20): absolute URL — module
 * prefix already composed onto the page's own `route.path` — route name, and
 * the App/Layout/Page triple.
 */
export const routes: PageRouteEntry[] = [
  {
    path: "/contact-us",
    name: "main.contact-us",
    triple: { app: App, layout, page: contactPage },
  },
  {
    // `/products` module prefix + the page's declared `/:id`.
    path: "/products/:id",
    name: "products.details",
    triple: { app: App, layout, page: productDetailsPage },
  },
];
