// Case 39b: decorator syntax parses fine, but the module still leaks a
// secret — Gate B's own boundary/secrets rule must catch this, not a
// parser crash and not silence once decorators are accepted.
function Entity(_target: unknown) {}

@Entity
class Widget {
  apiKey = process.env.SECRET_KEY;
}

export default function Case39bComponent() {
  return new Widget().apiKey;
}
