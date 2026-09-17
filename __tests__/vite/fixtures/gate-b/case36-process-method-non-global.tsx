// Innocent: `.process(...)` called on an ordinary object (a job queue, not
// globalThis/window/self or an alias of one) is unrelated to Node's global.
const job = {
  process() {
    return 1;
  },
};

export default function Case36Component() {
  return job.process();
}
