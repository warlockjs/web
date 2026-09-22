import type { SharedContext } from "../index";
import type {
  MetadataChild,
  MetadataInput,
  MetadataOutput,
  MetadataTitleInput,
  PageMetadata,
  ResolvedMetadata,
} from "../metadata";
import type { PipelineLoader } from "./execute-page-request";
import { guardMetadataAgainstDeferredKeys } from "./metadata-deferred-guard";

export const ERROR_PAGE_METADATA: MetadataOutput = Object.freeze({
  title: "Something went wrong",
  robots: "noindex",
});
type Ancestor = {
  kind: "root" | "layout";
  metadata: PageMetadata<PipelineLoader> | undefined;
  data: unknown;
};
export type ResolvePageMetadataInput = {
  metadata: PageMetadata<PipelineLoader> | undefined;
  layoutRobots?: string;
  ancestors?: readonly Ancestor[];
  data: unknown;
  error: unknown;
  failed: boolean;
  shared: Readonly<SharedContext>;
  deferredKeys?: readonly string[];
  pagePath: string;
};
export type ResolvedPageMetadata = {
  metadata: MetadataOutput | undefined;
  thrown?: unknown;
  throwingLevel?: "app" | "layout" | "page";
};
type TitleState = { value?: string; template?: string; applied: boolean; absolute: boolean };
type Result = { metadata: MetadataOutput; title: TitleState };
type MetadataFunction = Extract<PageMetadata<PipelineLoader>, (...args: never) => unknown>;

function cloneFreeze(value: MetadataOutput): ResolvedMetadata {
  return Object.freeze({
    ...value,
    ...(value.keywords
      ? {
          keywords: Array.isArray(value.keywords)
            ? Object.freeze([...value.keywords])
            : value.keywords,
        }
      : {}),
    ...(value.openGraph ? { openGraph: Object.freeze({ ...value.openGraph }) } : {}),
    ...(value.twitter ? { twitter: Object.freeze({ ...value.twitter }) } : {}),
  }) as ResolvedMetadata;
}
function child(
  kind: "layout" | "page",
  value: MetadataOutput,
  nested?: MetadataChild,
): MetadataChild {
  return Object.freeze({
    kind,
    metadata: cloneFreeze(value),
    ...(nested ? { child: nested } : {}),
  });
}
function titleOf(input: MetadataTitleInput | undefined): TitleState {
  if (typeof input === "string") return { value: input, applied: false, absolute: false };
  if (!input) return { applied: false, absolute: false };
  if ("absolute" in input && input.absolute !== undefined)
    return { value: input.absolute, applied: true, absolute: true };
  return { value: input.default, template: input.template, applied: false, absolute: false };
}
function renderTitle(own: TitleState, descendant: TitleState, ownAbsoluteWins = false): TitleState {
  if (descendant.absolute) return descendant;
  if (own.absolute && (ownAbsoluteWins || descendant.value === undefined)) return own;
  if (own.value !== undefined && descendant.value === undefined && own.template) {
    return { ...own, applied: true };
  }
  const value = descendant.value ?? own.value;
  if (value === undefined) return { ...descendant, template: own.template ?? descendant.template };
  if (descendant.applied)
    return { ...descendant, value, template: own.template ?? descendant.template };
  if (own.template)
    return {
      value: own.template.replace(/%s/g, value),
      template: own.template,
      applied: true,
      absolute: false,
    };
  return { ...descendant, value, template: own.template ?? descendant.template };
}
function composeStatic(own: MetadataInput, descendant?: Result): Result {
  const { title: ownTitle, openGraph: ownOg, twitter: ownTwitter, ...ownRest } = own;
  const lower = descendant?.metadata ?? {};
  const title = renderTitle(
    titleOf(ownTitle),
    descendant?.title ?? { applied: false, absolute: false },
  );
  return {
    title,
    metadata: {
      ...ownRest,
      ...lower,
      ...(ownOg || lower.openGraph ? { openGraph: { ...ownOg, ...lower.openGraph } } : {}),
      ...(ownTwitter || lower.twitter ? { twitter: { ...ownTwitter, ...lower.twitter } } : {}),
      ...(title.value === undefined ? {} : { title: title.value }),
    },
  };
}
function composeCallback(own: MetadataInput, descendant?: Result): Result {
  const { title: ownTitle, ...ownRest } = own;
  if (!descendant) {
    const title = renderTitle(titleOf(ownTitle), { applied: false, absolute: false });
    return {
      metadata: { ...ownRest, ...(title.value === undefined ? {} : { title: title.value }) },
      title,
    };
  }
  if (descendant.title.absolute)
    return { metadata: { ...ownRest, title: descendant.title.value }, title: descendant.title };
  if (ownTitle === undefined)
    return { metadata: ownRest, title: { applied: false, absolute: false } };
  const title =
    typeof ownTitle === "string"
      ? {
          value: ownTitle,
          template: descendant.title.template,
          applied: ownTitle === descendant.title.value && descendant.title.applied,
          absolute: false,
        }
      : renderTitle(titleOf(ownTitle), descendant.title, true);
  return {
    metadata: { ...ownRest, ...(title.value === undefined ? {} : { title: title.value }) },
    title,
  };
}
function evaluate(
  metadata: PageMetadata<PipelineLoader> | undefined,
  data: unknown,
  shared: Readonly<SharedContext>,
  childMetadata?: MetadataChild,
): { input: MetadataInput; callback: boolean } {
  if (typeof metadata !== "function") return { input: metadata ?? {}, callback: false };
  return {
    input: (metadata as MetadataFunction)({
      data: data as Parameters<MetadataFunction>[0]["data"],
      shared,
      ...(childMetadata ? { child: childMetadata } : {}),
    }),
    callback: true,
  };
}
function withLayoutRobots(metadata: MetadataOutput, robots: string | undefined): MetadataOutput {
  return robots === undefined || metadata.robots !== undefined ? metadata : { ...metadata, robots };
}
export function resolvePageMetadata(input: ResolvePageMetadataInput): ResolvedPageMetadata {
  if (input.failed) return { metadata: ERROR_PAGE_METADATA };
  let throwingLevel: "app" | "layout" | "page" = "page";
  try {
    const data = guardMetadataAgainstDeferredKeys(input.data, input.deferredKeys, input.pagePath);
    const page = evaluate(input.metadata, data, input.shared);
    let resolved = page.callback ? composeCallback(page.input) : composeStatic(page.input);
    let nested: MetadataChild | undefined = child("page", resolved.metadata);
    for (const ancestor of [...(input.ancestors ?? [])].reverse()) {
      if (!ancestor.metadata) continue;
      throwingLevel = ancestor.kind === "root" ? "app" : "layout";
      const own = evaluate(ancestor.metadata, ancestor.data, input.shared, nested);
      resolved = own.callback
        ? composeCallback(own.input, resolved)
        : composeStatic(own.input, resolved);
      if (ancestor.kind === "layout") nested = child("layout", resolved.metadata, nested);
    }
    const hasDeclaredMetadata =
      input.metadata !== undefined ||
      (input.ancestors ?? []).some((ancestor) => ancestor.metadata !== undefined);
    return {
      metadata:
        hasDeclaredMetadata || input.layoutRobots !== undefined
          ? withLayoutRobots(resolved.metadata, input.layoutRobots)
          : undefined,
    };
  } catch (thrown) {
    return { metadata: ERROR_PAGE_METADATA, thrown, throwingLevel };
  }
}
