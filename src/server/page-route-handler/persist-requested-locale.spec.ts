import { describe, expect, it, vi } from "vitest";
import { persistRequestedLocale } from "./persist-requested-locale";

function request(query: Record<string, unknown>, provisional = false) {
  return {
    query,
    locale: "ar",
    header: (name: string) =>
      name === "x-warlock-locale-provisional" && provisional ? "1" : undefined,
  } as never;
}

describe("persistRequestedLocale", () => {
  it("keeps ordinary locale-bearing data requests on the legacy persistence path", () => {
    const response = { setLocale: vi.fn() };

    persistRequestedLocale(request({ locale: "ar" }), response as never);

    expect(response.setLocale).toHaveBeenCalledWith("ar");
  });

  it("does not write the legacy cookie for a provisional locale-switch request", () => {
    const response = { setLocale: vi.fn() };

    persistRequestedLocale(request({ locale: "ar" }, true), response as never);

    expect(response.setLocale).not.toHaveBeenCalled();
  });
});
