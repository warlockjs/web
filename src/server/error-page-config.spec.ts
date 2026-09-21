import { describe, expect, it } from "vitest";
import { InvalidPageModuleConfigError } from "./normalize-page-module";
import { resolveErrorPageMetadata } from "./error-page";

const ErrorPage = () => null;

describe("error.page.tsx config ingress", () => {
  it("reads metadata from config while retaining the framework noindex floor", () => {
    const module = {
      default: ErrorPage,
      config: {
        metadata: ({ status }: { status: number }) => ({
          title: `Error ${status}`,
          robots: "index",
        }),
      },
    };

    expect(resolveErrorPageMetadata(module, { error: new Error("boom"), status: 503 })).toEqual({
      title: "Error 503",
      robots: "index",
    });
  });

  it("does not accept a legacy top-level metadata export", () => {
    expect(() =>
      resolveErrorPageMetadata(
        { default: ErrorPage, metadata: { title: "legacy" } },
        { error: new Error("boom"), status: 500 },
      ),
    ).toThrow(InvalidPageModuleConfigError);
  });

  it("requires an error page default through the page normalizer", () => {
    expect(() =>
      resolveErrorPageMetadata(
        { config: { metadata: { title: "Missing" } } },
        { error: "boom", status: 500 },
      ),
    ).toThrow("default export");
  });
});
