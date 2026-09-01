// A worker pool over an array, which exists because `Promise.all` over a list
// whose length a client controls is a fan-out with no ceiling.
//
// #152: `GET …/runs/{id}/verify` fanned out over every session in a run at
// once, behind a plain `repo:read` token. Each of those tasks reads from the
// database and hashes what it reads, so the peak cost of one request was the
// number of sessions multiplied by the size of the largest — a product the
// caller sets and the server does not bound. Bounding the width turns that
// product back into a sum with a constant factor.
//
// Results come back in the order of `items`, not the order they finished, so a
// caller can zip them against the input the way `Promise.all` allows.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError(`concurrency limit must be at least 1, got ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;

  // One worker per slot, each pulling the next index until the list is empty.
  // A rejection propagates: the pool is a scheduling change, not an error
  // policy, and swallowing a failure here would make a verification that could
  // not read its rows look like one that read them and found nothing wrong.
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return results;
}
