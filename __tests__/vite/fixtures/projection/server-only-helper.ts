// Only ever read by the loader — after projection nothing references it.
export async function fetchDraftStats() {
  return { drafts: 0 };
}
