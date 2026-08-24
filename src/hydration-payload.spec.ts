import { describe, expect, it } from "vitest";
import { PAYLOAD_SCRIPT_ID } from "./components/document-context";
import { readHydrationPayload } from "./hydration-payload";

function makeDocument(scriptTextContent: string | null): Document {
  return {
    getElementById(id: string) {
      if (id !== PAYLOAD_SCRIPT_ID) return null;
      if (scriptTextContent === null) return null;
      return { textContent: scriptTextContent } as unknown as HTMLElement;
    },
  } as unknown as Document;
}

const fullPayload = {
  appData: { a: 1 },
  layoutData: { l: 1 },
  pageData: { p: 1 },
  shared: { s: 1 },
  name: "home",
};

describe("readHydrationPayload", () => {
  it("parses and returns a payload object with all five keys", () => {
    const documentNode = makeDocument(JSON.stringify(fullPayload));

    expect(readHydrationPayload(documentNode)).toEqual(fullPayload);
  });

  it("throws the malformed message when name is missing", () => {
    const { name, ...withoutName } = fullPayload;

    const documentNode = makeDocument(JSON.stringify(withoutName));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the absent message when the script element is not found", () => {
    const documentNode = makeDocument(null);

    expect(() => readHydrationPayload(documentNode)).toThrow(
      new RegExp(`Warlock hydration payload is absent: #${PAYLOAD_SCRIPT_ID}`),
    );
  });

  it("throws the malformed message when the script content is not valid JSON", () => {
    const documentNode = makeDocument("not json");

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });

  it("throws the malformed message when another required key is missing", () => {
    const { shared, ...withoutShared } = fullPayload;

    const documentNode = makeDocument(JSON.stringify(withoutShared));

    expect(() => readHydrationPayload(documentNode)).toThrow(
      /Warlock hydration payload was found at #.* but could not be read\./,
    );
  });
});
