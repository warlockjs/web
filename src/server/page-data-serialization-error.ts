/**
 * The single place a loader value that devalue cannot put on the wire becomes
 * a loud, named failure — in dev AND in prod (the ruling never gates this on
 * `NODE_ENV`: a browser cannot hydrate a value the server could not send it,
 * regardless of which environment produced it).
 *
 * devalue already knows exactly what it refuses and where (`DevalueError`,
 * `.path`) — this module wraps that error rather than re-detecting the same
 * thing, and adds the two facts devalue cannot know on its own: which LOADER
 * LEVEL (app/layout/page) produced the value, and which page ROUTE the
 * request was for.
 */
import { DevalueError, stringify } from "devalue";

/** The three loader levels a hydration payload's data can come from. */
export type PageDataLevel = "app" | "layout" | "page";

/**
 * Thrown when a loader's returned value contains something devalue refuses —
 * a class instance devalue does not recognize, a function, a symbol, and so
 * on.
 *
 * The message names the loader level, the key path devalue's own error
 * reports (e.g. `.items[0].handler`), and the page route, then points at the
 * fix the standing ruling settled on: give the offending value a resource /
 * `toJSON()` so it reaches the wire as the plain value devalue already knows
 * how to serialize. This class never re-implements devalue's own detection —
 * it only carries `DevalueError` forward with the context devalue itself
 * cannot have.
 */
export class PageDataSerializationError extends Error {
  public constructor(
    public readonly level: PageDataLevel,
    public readonly path: string,
    public readonly route: string,
    public override readonly cause: DevalueError,
  ) {
    super(
      `Cannot serialize ${level} data for route "${route}" (key path: ${
        path.length > 0 ? path : "<root>"
      }): ${cause.message}. devalue cannot put a class instance, a function or a symbol on the ` +
        "hydration wire — give the offending value a resource or a toJSON() so it reaches the " +
        "browser as a plain value. A resource / toJSON() is the serialization gate for page data.",
    );
    this.name = "PageDataSerializationError";
  }
}

/**
 * Validate that `value` can travel the devalue wire, attributing any failure
 * to `level` and `route`.
 *
 * Deliberately serializes and discards the result: this is a VALIDATION pass,
 * run once per level at payload-build time, so a class instance a loader
 * returned is caught with the right level/route/key path attached before it
 * ever reaches a caller that only knows "the payload" as one combined object.
 * The real serialization that puts bytes on the wire happens later, in
 * whichever wire path (document script, NDJSON line, data-request body) reads
 * this same value.
 */
export function assertPageDataSerializable(value: unknown, level: PageDataLevel, route: string): void {
  try {
    stringify(value);
  } catch (error) {
    if (error instanceof DevalueError) {
      throw new PageDataSerializationError(level, error.path, route, error);
    }

    throw error;
  }
}
