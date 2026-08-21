import type { AppLoader, AppProps } from "../../../src/index";
import { Head, Scripts, shared } from "../../../src/index";
import "./types";

/**
 * The fixture application root, in the v5/app contract shape (v5/app
 * src/web/App.tsx): middleware chain first, loader `satisfies AppLoader`,
 * a component that never sees request/response.
 */

/**
 * `base` — guest defaults for every required `SharedContext` key, exactly
 * v5/app's rule (base.middleware.ts): a required key needs an unconditional
 * writer, and it runs first so the type is true before anything can
 * early-return.
 */
const base = async (_ctx: { request: any; response: any }) => {
  shared.locale = "en";
  shared.appName = "Fixture Store";
};

/** Conditional writer for an OPTIONAL key (publish-user's shape). */
const publishUser = async ({ request }: { request: any; response: any }) => {
  const name = request.input("user");

  if (name) shared.user = { name };
};

export const middleware = [base, publishUser];

export const loader = (async () => ({
  appName: shared.appName,
})) satisfies AppLoader;

export default function App({ data, children }: AppProps<typeof loader>) {
  return (
    <html>
      <head>
        <Head />
      </head>
      <body>
        <div id="app" data-app-name={data?.appName}>
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
