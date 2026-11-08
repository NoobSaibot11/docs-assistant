<docs-decorative-header title="Routing" imgSrc="adev/src/assets/images/routing.svg"> <!-- markdownlint-disable-line -->
The router maps URL paths to components so users can move between views.
</docs-decorative-header>

## Define routes

Each route pairs a `path` with the `component` the router renders for it.

```ts
export const routes: Routes = [
  { path: 'heroes', component: HeroList },
  { path: 'heroes/:id', component: HeroDetail },
];
```

## Provide the router

Pass the routes to `provideRouter` in the application config.

```ts
bootstrapApplication(App, { providers: [provideRouter(routes)] });
```

## Read route parameters

Inject `ActivatedRoute` and read `paramMap` to get the `:id` parameter of the current URL.
