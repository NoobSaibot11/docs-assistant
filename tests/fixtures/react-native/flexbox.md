---
id: flexbox
title: Layout with Flexbox
---

A component specifies the layout of its children with the flexbox algorithm, so the same layout works on different screen sizes.

## Flex direction

`flexDirection` controls the main axis. The default in React Native is `column`, unlike the web where it is `row`.

```tsx
<View style={{flexDirection: 'row'}}>
  <View style={{width: 50, height: 50, backgroundColor: 'powderblue'}} />
</View>
```

## Justify content

`justifyContent` aligns children along the main axis: `flex-start`, `center`, `flex-end`, `space-between` or `space-around`.

## Align items

`alignItems` aligns children along the cross axis. `stretch` is the default.
