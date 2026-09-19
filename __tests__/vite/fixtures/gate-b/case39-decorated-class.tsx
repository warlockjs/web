// Case 39: a TS decorator on a class — the shape a `@warlock.js/cascade`
// model uses (`4344e32a`) — reached from the client graph. No secret is
// read anywhere here; this fixture only proves Gate B's own parser accepts
// decorator syntax instead of crashing before the boundary/secrets rule
// ever runs.
function Entity(_target: unknown) {}

@Entity
class Widget {
  name = "widget";
}

export default function Case39Component() {
  return new Widget().name;
}
