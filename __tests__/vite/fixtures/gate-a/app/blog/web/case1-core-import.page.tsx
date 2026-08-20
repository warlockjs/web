// Case 1: a page importing a @warlock.js/core service DIRECTLY — must fail.
import { database } from "@warlock.js/core";

export const route = { path: "/blog" };

export default function BlogPage() {
  return database;
}
