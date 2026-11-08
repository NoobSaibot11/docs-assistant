---
id: flatlist
title: FlatList
---

import Tabs from '@theme/Tabs';

A performant interface for rendering long scrollable lists. Only the rows near the screen are rendered.

## Render a list

Pass the items in `data` and a `renderItem` function that returns one row.

```tsx
<FlatList
  data={DATA}
  renderItem={({item}) => <Text>{item.title}</Text>}
  keyExtractor={item => item.id}
/>
```

## Pull to refresh

Set `onRefresh` and `refreshing` to add a standard pull-to-refresh control.

## Load more on scroll

`onEndReached` is called when the list scrolls within `onEndReachedThreshold` of the end; use it to fetch the next page of items.
