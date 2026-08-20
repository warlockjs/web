// Composed pipeline — case 3 (Gate B): an inline process.env read inside
// the page COMPONENT itself, not a server export. Projection only strips
// the 5 named server exports and leaves the default export untouched, so
// this secret read survives projection and must still be refused — by
// Gate B this time, proving all three plugins fire correctly when composed.
export default function BlogPage() {
  return process.env.SECRET_KEY;
}
