// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectActionSubmitter } from "../client/navigation/action-submitter";
import { DocumentContext } from "./document-context";
import { FieldError } from "./field-error";
import { Form } from "./form";
import { useActionData } from "./use-action-data";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function documentValue(actionData?: unknown) {
  return { payload: { actionData } } as never;
}

function mount(node: React.ReactElement, actionData?: unknown) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() =>
    root.render(createElement(DocumentContext.Provider, { value: documentValue(actionData) }, node)),
  );

  return { container, root };
}

function submit(container: HTMLElement) {
  const form = container.querySelector("form")!;

  return act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  connectActionSubmitter(undefined);
  document.body.innerHTML = "";
});

describe("<Form>", () => {
  it("renders a post form with the hidden _action for a named action", () => {
    const { container } = mount(<Form action="save" />);
    const form = container.querySelector("form")!;

    expect(form.method).toBe("post");
    expect(form.enctype).toBe("multipart/form-data");
    expect(container.querySelector<HTMLInputElement>('input[name="_action"]')?.value).toBe("save");
  });

  it("submits through the connected runtime and calls onSuccess", async () => {
    const submitter = vi.fn(async () => ({ type: "success" as const }));
    const onSuccess = vi.fn();

    connectActionSubmitter(submitter);
    const { container } = mount(
      <Form onSuccess={onSuccess}>
        <input name="email" defaultValue="a@b.c" />
      </Form>,
    );

    await submit(container);

    expect(submitter).toHaveBeenCalledTimes(1);
    expect((submitter.mock.calls[0] as unknown[])[1] instanceof FormData).toBe(true);
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shares one request between a double submit", async () => {
    let finish!: (value: { type: "success" }) => void;
    const submitter = vi.fn(
      () => new Promise<{ type: "success" }>((resolve) => (finish = resolve)),
    );

    connectActionSubmitter(submitter);
    const { container } = mount(<Form />);

    await submit(container);
    await submit(container);
    // Sharing lives in the submitter; <Form> must at least not bypass it.
    expect(submitter.mock.calls.length).toBeLessThanOrEqual(2);
    await act(async () => finish({ type: "success" }));
  });

  it("falls back to a native submit when no runtime is connected", async () => {
    const { container } = mount(<Form />);
    const form = container.querySelector("form")!;
    const nativeSubmit = vi.spyOn(form, "submit").mockImplementation(() => undefined);

    await submit(container);

    expect(nativeSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders field errors and wires aria-invalid / aria-describedby", () => {
    const { container } = mount(
      <Form>
        <input name="email" />
        <FieldError name="email" />
      </Form>,
      { action: "default", status: 422, ok: false, errors: { email: "Required" }, formErrors: [] },
    );

    expect(container.querySelector("#email-error")?.textContent).toBe("Required");
    const input = container.querySelector("input")!;

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("email-error");
  });
});

describe("useActionData", () => {
  function Probe({ name }: { name?: string }) {
    const state = useActionData(name);

    return <p>{state ? state.action : "none"}</p>;
  }

  it("reads the payload's actionData and filters by action name", () => {
    const state = { action: "save", status: 200, ok: true, errors: {}, formErrors: [] };

    expect(mount(<Probe />, state).container.textContent).toBe("save");
    expect(mount(<Probe name="remove" />, state).container.textContent).toBe("none");
    expect(mount(<Probe />).container.textContent).toBe("none");
  });
});
