// Case 20: the vendor is CommonJS and reaches the builtin through `require`.
import { vendorHostname } from "vendor-cjs-node-lib";

export const route = { path: "/blog/vendor-cjs" };

export default function BlogPage() {
  return vendorHostname();
}
