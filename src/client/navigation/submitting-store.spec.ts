import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  beginSubmitting,
  readSubmitting,
  subscribeSubmitting,
  useIsSubmitting,
} from "./submitting-store";

describe("submitting store", () => {
  it("keeps a replacement ticket submitting when the superseded one completes", () => {
    const first = beginSubmitting();
    const second = beginSubmitting();

    first();
    expect(readSubmitting()).toBe(true);

    second();
    expect(readSubmitting()).toBe(false);
  });

  it("does not pulse false while a new ticket replaces the current one", () => {
    const changes: boolean[] = [];
    const unsubscribe = subscribeSubmitting(() => changes.push(readSubmitting()));
    const first = beginSubmitting();
    const second = beginSubmitting();

    first();
    second();
    unsubscribe();

    expect(changes).toEqual([true, false]);
  });

  it("renders false on the server", () => {
    function Probe() {
      return createElement("span", null, String(useIsSubmitting()));
    }

    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>false</span>");
  });
});
