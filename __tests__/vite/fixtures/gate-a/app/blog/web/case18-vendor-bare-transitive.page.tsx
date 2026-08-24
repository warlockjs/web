// Case 18: case 17 with the bare builtin spelling inside the vendor package.
import { hashVendorInput } from "vendor-bare-node-lib";

export const route = { path: "/blog/vendor-bare" };

export default function BlogPage() {
  return hashVendorInput("warlock");
}
