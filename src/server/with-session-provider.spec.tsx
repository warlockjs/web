import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useUser } from "../session/use-user";
import { withSessionProvider } from "./with-session-provider";

function WhoAmI() {
  const user = useUser() as { name?: string } | null;

  return createElement("span", null, user === null ? "guest" : String(user.name));
}

describe("withSessionProvider", () => {
  it("renders the resolved user during SSR without touching the client store", () => {
    const html = renderToString(
      withSessionProvider({ user: { id: 1, name: "Ada" } }, createElement(WhoAmI)),
    );

    expect(html).toContain("Ada");
    expect(renderToString(createElement(WhoAmI))).toContain("guest");
  });

  it("renders a guest for a session payload with no user", () => {
    expect(renderToString(withSessionProvider({ user: null }, createElement(WhoAmI)))).toContain(
      "guest",
    );
  });

  it("leaves the tree untouched when no session key is present", () => {
    const element = createElement(WhoAmI);

    expect(withSessionProvider(undefined, element)).toBe(element);
  });
});
