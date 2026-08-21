// Gate C / Part 2 manifest fixture: reads two declared PUBLIC_* vars (one
// safe-looking, one secret-shaped — named PUBLIC_STRIPE_KEY, Suki's own
// example of a prefix rule failing on its own). The test's build ALSO
// declares a third PUBLIC_* var this file never reads, to prove the
// manifest lists exactly the read ones — agreeing, by construction, with
// Gate B's own unread-key exclusion (gate-b-secrets.spec.ts case 9).
export default function ManifestEntryPage() {
  return `${import.meta.env.PUBLIC_API_URL} / ${import.meta.env.PUBLIC_STRIPE_KEY}`;
}
