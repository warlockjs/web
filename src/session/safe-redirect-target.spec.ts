import { describe, expect, it } from "vitest";
import { safeRedirectTarget } from "./safe-redirect-target";

describe("safeRedirectTarget", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeRedirectTarget("/account")).toBe("/account");
    expect(safeRedirectTarget("/a/b?x=1#h")).toBe("/a/b?x=1#h");
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash", "/\\evil.com"],
    ["absolute", "https://evil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["control character", "/a\nb"],
    ["relative without slash", "account"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(safeRedirectTarget(value)).toBeUndefined();
  });

  it("rejects non-strings", () => {
    expect(safeRedirectTarget(undefined)).toBeUndefined();
    expect(safeRedirectTarget(["/a"])).toBeUndefined();
  });
});
