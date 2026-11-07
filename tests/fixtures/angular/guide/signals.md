<docs-decorative-header title="Angular Signals" imgSrc="adev/src/assets/images/signals.svg"> <!-- markdownlint-disable-line -->
Angular Signals is a system that tracks how and where your state is used.
</docs-decorative-header>

## What are signals?

A **signal** is a wrapper around a value that notifies interested consumers when that value changes.

### Writable signals

Create a writable signal with the `signal` function:

```ts
const count = signal(0);
count.set(3);
count.update(value => value + 1);
```

<docs-callout important title="Signals are synchronous">
Reading a signal always returns its current value; there is no subscription to manage.
</docs-callout>

### Computed signals

<docs-code path="adev/src/content/examples/signals/src/computed.ts" />

A computed signal derives its value from other signals and is read-only.
