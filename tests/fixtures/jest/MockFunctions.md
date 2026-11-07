---
id: mock-functions
title: Mock Functions
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

Mock functions let you test the links between code by erasing the actual implementation of a function and capturing calls to it.

## Using a mock function {#using-a-mock}

Let's test a function that calls a callback for each item in an array.

```js title="forEach.test.js"
import {forEach} from './forEach';

const mockCallback = jest.fn(x => 42 + x);

test('forEach mock function', () => {
  forEach([0, 1], mockCallback);
  expect(mockCallback.mock.calls).toHaveLength(2);
});
```

:::tip

Use `mockFn.mockClear()` to reset the recorded calls between tests.

:::

## Mocking modules

Use `jest.mock` to replace a whole module with an automatic mock.

<Tabs>
<TabItem value="js" label="JavaScript">

```js
jest.mock('axios');
```

</TabItem>
<TabItem value="ts" label="TypeScript">

```ts
jest.mock('axios');
```

</TabItem>
</Tabs>

## Example

The first example section.

## Example

A second section with the same title, to check anchor de-duplication.
