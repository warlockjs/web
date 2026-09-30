// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { stringify } from "devalue";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HYDRATION_ROOT_ID, PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { resetClientErrorReporterForTests, onClientError } from "./report-client-error";
import { resetSession, SessionContext, useUser } from "../session/use-user";
import { hydratePage } from "./hydrate-page";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let previousActEnvironment: boolean | undefined;
let hydratedRoot: Root | undefined;

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    hydrateRoot(...args: Parameters<typeof actual.hydrateRoot>) {
      hydratedRoot = actual.hydrateRoot(...args);
      return hydratedRoot;
    },
  };
});

const payload = {
  appData: null,
  layoutData: null,
  pageData: null,
  shared: {},
  name: "home",
  locale: "en",
  translations: {},
};

function installDocument(): void {
  document.body.innerHTML =
    `<div id="${HYDRATION_ROOT_ID}"><div>ready</div></div>` +
    `<script id="${PAYLOAD_SCRIPT_ID}" type="application/json">${stringify(payload)}</script>`;
}

async function hydrateWith(strictMode: boolean | undefined): Promise<{
  renders: number;
  setup: number;
  cleanup: number;
  freshSetup: number;
  freshCleanup: number;
}> {
  let renders = 0;
  let setup = 0;
  let cleanup = 0;
  let freshSetup = 0;
  let freshCleanup = 0;
  let reveal: (() => void) | undefined;

  function FreshChild() {
    useEffect(() => {
      freshSetup += 1;
      return () => {
        freshCleanup += 1;
      };
    }, []);
    return null;
  }

  function Probe() {
    renders += 1;
    const [visible, setVisible] = useState(false);
    reveal = () => setVisible(true);
    useEffect(() => {
      setup += 1;
      return () => {
        cleanup += 1;
      };
    }, []);

    return createElement("div", null, "ready", visible ? createElement(FreshChild) : null);
  }

  await act(async () => {
    hydratePage(() => createElement(Probe), strictMode === undefined ? undefined : { strictMode });
  });

  const hydration = { renders, setup, cleanup };
  await act(async () => {
    if (!reveal) throw new Error("hydrated component did not expose its update");
    reveal();
  });

  return { ...hydration, freshSetup, freshCleanup };
}

beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    hydratedRoot?.unmount();
  });
  hydratedRoot = undefined;
  resetSession();
  resetClientErrorReporterForTests();
  if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("hydratePage strict mode", () => {
  it.each([
    [true, { renders: 2, setup: 1, cleanup: 0, freshSetup: 2, freshCleanup: 1 }],
    [false, { renders: 1, setup: 1, cleanup: 0, freshSetup: 1, freshCleanup: 0 }],
    [undefined, { renders: 1, setup: 1, cleanup: 0, freshSetup: 1, freshCleanup: 0 }],
  ])(
    "uses strict mode %s for hydration renders and later mount effects",
    async (strictMode, expected) => {
      installDocument();
      expect(await hydrateWith(strictMode)).toEqual(expected);
    },
  );

  it("seeds useUser from the session payload before the first real hydration render", async () => {
    const user = { id: 7, name: "Ada" };
    const firstClientUsers: unknown[] = [];
    const recoverableErrors = vi.fn();
    let renderingServerMarkup = true;

    function WhoAmI() {
      const currentUser = useUser() as { id: string | number; name: string } | null;
      if (!renderingServerMarkup) firstClientUsers.push(currentUser);

      return createElement("span", null, currentUser === null ? "guest" : currentUser.name);
    }

    const serverMarkup = renderToString(
      createElement(SessionContext.Provider, { value: { user } }, createElement(WhoAmI)),
    );
    renderingServerMarkup = false;
    document.body.innerHTML =
      `<div id="${HYDRATION_ROOT_ID}">${serverMarkup}</div>` +
      `<script id="${PAYLOAD_SCRIPT_ID}" type="application/json">${stringify({
        ...payload,
        session: { user },
      })}</script>`;
    onClientError((event) => {
      if (event.kind === "hydration") recoverableErrors(event);
    });

    await act(async () => {
      hydratePage(() => createElement(WhoAmI));
    });

    expect(firstClientUsers).toEqual([user]);
    expect(recoverableErrors).not.toHaveBeenCalled();
    expect(document.querySelector(`#${HYDRATION_ROOT_ID}`)?.textContent).toBe("Ada");
  });
});
