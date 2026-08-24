// Case 11: `server/` may sit ANYWHERE under the app source, not only beneath
// a module's `web/` folder. Extensionless again, so rule 4 abstains and the
// refusal can only come from the folder rule.
import { usersServerRepo } from "../../users/server/repo";

export const route = { path: "/blog/app-server-folder" };

export default function BlogPage() {
  return usersServerRepo();
}
