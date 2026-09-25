import type { Request, Response } from "@warlock.js/core";

/**
 * Augmented by the application to describe its identity:
 *
 * @example
 * declare module "@warlock.js/web" {
 *   interface SessionRegistry { user: UserSessionOutput; model: User }
 * }
 */
// biome-ignore lint/suspicious/noEmptyInterface: an augmentation point must be an interface.
export interface SessionRegistry {}

type Registered<Key extends string, Fallback> = SessionRegistry extends Record<Key, infer Value>
  ? Value
  : Fallback;

/** The wire projection of the signed-in user (constrained to carry an `id`). */
export type SessionUser = Registered<"user", { id: string | number }>;

/** The server-side model behind the projection. */
export type SessionModel = Registered<"model", unknown>;

/**
 * The seam `web.session` accepts. Auth's `pageSession()` satisfies it
 * structurally; web never imports auth.
 */
export type SessionResolver<
  TModel extends SessionModel = SessionModel,
  TUser extends { id: string | number } = SessionUser & { id: string | number },
> = {
  resolve(request: Request, response: Response): Promise<{ model: TModel; user: TUser } | null>;
};
