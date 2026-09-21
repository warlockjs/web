import { describe, expect, it } from "vitest";
import { readMetadataKeys } from "./read-metadata-keys";

describe("readMetadataKeys", () => {
  it("reads config.metadata through as const and satisfies wrappers", () => {
    expect(
      readMetadataKeys(
        "example.page.tsx",
        'export const config = { metadata: { tittle: "Example", openGraph: { descriptoin: "x" } } } as const satisfies PageConfig;',
      ),
    ).toMatchObject([
      { container: "config.metadata", key: "tittle", suggestion: "title" },
      { container: "config.metadata.openGraph", key: "descriptoin", suggestion: "description" },
    ]);
  });

  it("reads an inline metadata method without evaluating it", () => {
    expect(
      readMetadataKeys(
        "example.page.tsx",
        "export const config = { metadata(props) { return { tittle: props.title }; } };",
      ),
    ).toMatchObject([{ container: "config.metadata", key: "tittle", suggestion: "title" }]);
  });

  it("does not evaluate helper-valued metadata or accept the legacy export", () => {
    expect(
      readMetadataKeys("example.page.tsx", "export const config = { metadata: buildMetadata() };"),
    ).toEqual([]);
    expect(
      readMetadataKeys("example.page.tsx", 'export const metadata = { tittle: "x" };'),
    ).toEqual([]);
  });
});
