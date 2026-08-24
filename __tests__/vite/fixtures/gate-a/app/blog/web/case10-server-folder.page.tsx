// Case 10: a `server/` folder under the app source, reached from a client
// entry. The specifier is extensionless, which is this repo's own import
// convention — and which is precisely why rule 4 does not judge it (see the
// note on case 9). Before the folder rule existed this import was ALLOWED.
import { serverRepo } from "./server/repo";

export const route = { path: "/blog/server-folder" };

export default function BlogPage() {
  return serverRepo();
}
