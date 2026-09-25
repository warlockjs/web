// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSubmitForm } from "./use-submit-form";
import { publishNamedApiRoutes } from "../routing/named-api-routes";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function result(data: unknown = { ok: true }) {
  return {
    data,
    error: null,
    status: 200,
    response: new Response(),
    headers: {},
    request: { method: "POST", url: "/api/orders", headers: {} },
  };
}

function failure(body: unknown) {
  return {
    data: null,
    error: { body, isValidationError: true, isAborted: false },
    status: 422,
    response: new Response(),
    headers: {},
    request: { method: "POST", url: "/api/orders", headers: {} },
  };
}

function formContext(values: Record<string, unknown> = { name: "Ada" }) {
  const controls = [
    {
      name: "name",
      error: null as unknown,
      setError: vi.fn(function (this: any, error: unknown) {
        this.error = error;
      }),
    },
  ];
  return {
    form: {
      controls: () => controls,
      setErrors: vi.fn((errors: Record<string, string>) =>
        controls.forEach((control) => {
          if (errors[control.name]) control.setError(errors[control.name]);
        }),
      ),
    },
    values,
    formData: new FormData(),
  } as any;
}

function mount(options: any) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let value: ReturnType<typeof useSubmitForm> | undefined;
  function Probe() {
    value = useSubmitForm(options);
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    root,
    get value() {
      return value!;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("useSubmitForm", () => {
  it("prevents a duplicate while pending, settles full response, and sends FormData", async () => {
    const pending = deferred<any>();
    const cancel = vi.fn();
    const client = { request: vi.fn(() => Object.assign(pending.promise, { cancel })) };
    const view = mount({ path: "/api/orders/:id", params: { id: "a b" }, client });
    const context = formContext();

    await act(async () => {
      void view.value.submit(context);
    });
    await act(async () => {
      void view.value.submit(context);
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(view.value.isLoading).toBe(true);
    expect((client.request.mock.calls[0] as unknown[])[1]).toBe("/api/orders/a%20b");
    expect((client.request.mock.calls[0] as unknown[])[2]).toBe(context.formData);

    await act(async () => {
      pending.resolve(result());
      await pending.promise;
    });
    expect(view.value.response?.data).toEqual({ ok: true });
    expect(view.value.isLoading).toBe(false);
    act(() => view.root.unmount());
  });

  it("maps only registered default validation fields and exposes unmatched/general errors", async () => {
    const client = {
      request: vi.fn(() =>
        Object.assign(
          Promise.resolve(
            failure({
              message: "Correct fields",
              errors: [
                { input: "name", error: "Required" },
                { input: "hidden", error: "Nope" },
              ],
            }),
          ),
          { cancel: vi.fn() },
        ),
      ),
    };
    const view = mount({ path: "/api/orders", client });
    const context = formContext();

    await act(async () => {
      await view.value.submit(context);
    });
    expect(context.form.setErrors).toHaveBeenCalledWith({ name: "Required" });
    expect(view.value.formErrors).toEqual(["Correct fields", "hidden: Nope"]);
    expect(view.value.error?.body).toEqual(expect.objectContaining({ message: "Correct fields" }));
    act(() => view.root.unmount());
  });

  it("supports custom mapping and cancellation", async () => {
    const pending = deferred<any>();
    const cancel = vi.fn();
    const client = { request: vi.fn(() => Object.assign(pending.promise, { cancel })) };
    const map = vi.fn(() => ({ name: "Custom" }));
    const view = mount({ path: "/api/orders", client, mapFieldErrors: map });
    const context = formContext();
    await act(async () => {
      void view.value.submit(context);
    });
    await act(async () => {
      pending.resolve(failure({}));
      await pending.promise;
    });
    expect(map).toHaveBeenCalled();
    expect(context.form.setErrors).toHaveBeenCalledWith({ name: "Custom" });
    act(() => view.root.unmount());
  });

  it("shares deferred preflight work, and cancellation before it settles creates no request", async () => {
    const gate = deferred<boolean>();
    const client = { request: vi.fn() };
    const view = mount({ path: "/api/orders", client, beforeSubmit: () => gate.promise });
    const first = view.value.submit(formContext());
    const second = view.value.submit(formContext());
    expect(second).toBe(first);
    act(() => view.value.cancel("before request"));
    await act(async () => {
      gate.resolve(true);
      await first;
    });
    expect(client.request).not.toHaveBeenCalled();
    act(() => view.root.unmount());
  });

  it("keeps callback failures distinct from HTTP failures while completing", async () => {
    const onSuccess = vi.fn(() => {
      throw new Error("callback failed");
    });
    const onComplete = vi.fn();
    const client = {
      request: vi.fn(() => Object.assign(Promise.resolve(result()), { cancel: vi.fn() })),
    };
    const view = mount({ path: "/api/orders", client, onSuccess, onComplete });
    await act(async () => {
      await expect(view.value.submit(formContext())).rejects.toThrow("callback failed");
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(view.value.error).toBeNull();
    expect(view.value.response?.error).toBeNull();
    act(() => view.root.unmount());
  });

  it("leaves controls untouched when mapping is disabled and rejects files in GET query values", async () => {
    const client = {
      request: vi.fn(() =>
        Object.assign(
          Promise.resolve(failure({ errors: [{ input: "name", error: "Required" }] })),
          { cancel: vi.fn() },
        ),
      ),
    };
    const view = mount({ path: "/api/orders", client, mapFieldErrors: false });
    const context = formContext();
    await act(async () => {
      await view.value.submit(context);
    });
    expect(context.form.setErrors).not.toHaveBeenCalled();
    expect(view.value.formErrors).toEqual([]);
    const fileView = mount({ path: "/api/search", method: "GET", client });
    await expect(
      fileView.value.submit(formContext({ upload: new File(["x"], "x.txt") })),
    ).rejects.toThrow(/cannot be serialized/);
    act(() => view.root.unmount());
    act(() => fileView.root.unmount());
  });

  it("uses named route metadata and its registered method", async () => {
    publishNamedApiRoutes({ "orders.create": { path: "/api/orders/:id", method: "PATCH" } });
    const client = {
      request: vi.fn(() => Object.assign(Promise.resolve(result()), { cancel: vi.fn() })),
    };
    const view = mount({ route: "orders.create", params: { id: 9 }, client });
    await act(async () => {
      await view.value.submit(formContext());
    });
    expect((client.request.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      "PATCH",
      "/api/orders/9",
    ]);
    publishNamedApiRoutes(undefined);
    act(() => view.root.unmount());
  });

  it("does not invoke callbacks after unmount and callback throws are not turned into HTTP errors", async () => {
    const pending = deferred<any>();
    const cancel = vi.fn();
    const onSuccess = vi.fn();
    const client = { request: vi.fn(() => Object.assign(pending.promise, { cancel })) };
    const view = mount({ path: "/api/orders", client, onSuccess });
    await act(async () => {
      void view.value.submit(formContext());
    });
    act(() => view.root.unmount());
    expect(cancel).toHaveBeenCalledWith("component unmounted");
    await act(async () => {
      pending.resolve(result());
      await pending.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("useSubmitForm F2", () => {
  it("puts a 429 { message } body in formErrors", async () => {
    const tooMany = {
      ...failure({ message: "Slow down" }),
      status: 429,
      error: { body: { message: "Slow down" }, isValidationError: false, isAborted: false },
    };
    const client = {
      request: vi.fn(() => Object.assign(Promise.resolve(tooMany), { cancel: vi.fn() })),
    };
    const view = mount({ path: "/api/orders", client });

    await act(async () => {
      await view.value.submit(formContext());
    });
    expect(view.value.formErrors).toEqual(["Slow down"]);
    act(() => view.root.unmount());
  });
});
