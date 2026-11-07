---
id: timer-mocks
title: Timer Mocks
---

<!-- Fixture written for tests. HTML comments aren't valid MDX, so this file exercises the plain-Markdown fallback. -->

Native timer functions such as `setTimeout` and `setInterval` are awkward to test because they depend on real time. Fake timers replace them with versions you control.

## Enable fake timers

Call `jest.useFakeTimers()` at the top of the test file, or per test.

```js
jest.useFakeTimers();

test('waits one second before ending the game', () => {
  const timerGame = require('../timerGame');
  timerGame();
  expect(setTimeout).toHaveBeenCalledTimes(1);
});
```

## Run all timers

`jest.runAllTimers()` fast-forwards until every pending timer has run.

## Advance timers by time

`jest.advanceTimersByTime(msToRun)` runs only the timers due within the given number of milliseconds.
