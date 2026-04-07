---
title: "Express Handler Design in Multiple Schemas"
---

# Why Express Instances Are Used as Handlers in the Multiple-Schemas Pattern

The [multiple-schemas](./multiple-schemas.md) documentation includes a "single
endpoint, multiple GraphQL schemas" example that uses `express()` instances as
per-service handlers:

```ts
const services = {
  admin: {
    handler: express(),
    pgl: postgraphile({
      extends: [commonPreset],
      pgServices: [makePgService({ connectionString: "postgres:///admin" })],
    }),
  },
  user: {
    handler: express(),
    pgl: postgraphile({
      extends: [commonPreset],
      pgServices: [makePgService({ connectionString: "postgres:///user" })],
    }),
  },
};
```

This means there is an outer Express app (`app`) _and_ inner Express instances
(`handler: express()`) for each service. At first glance, nesting Express
instances may look unusual. This document explains why they are used and what
alternatives exist.

## How `addTo` works

Grafserv provides framework-specific adapters. Each adapter exposes an `addTo()`
method that mounts the GraphQL route handlers onto the framework's app instance.

For the Express v4 adapter (`grafserv/express/v4`), the signature is:

```ts
async addTo(
  app: Express,
  server: HTTPServer | HTTPSServer | null,
  addExclusiveWebsocketHandler = true,
)
```

Internally, `addTo` does two things:

1. **Registers a request middleware** via `app.use(this._createHandler())` - this
   is the function that processes incoming GraphQL/GraphiQL requests.
2. **Sets up WebSocket upgrade handling** on the HTTP server (if websockets are
   enabled and a server reference is provided).

The key constraint is that `addTo()` expects an `Express` instance as its first
argument. It does not accept a bare `(req, res, next)` callback.

## Why `express()` sub-apps are used

In the single-endpoint pattern, each service needs its own isolated handler that
can be invoked conditionally based on request properties (e.g., whether the user
is an admin). The switching middleware looks like:

```ts
app.use((req, res, next) => {
  const isAdmin = req.user?.isAdmin;
  if (isAdmin) {
    services.admin.handler(req, res, next);
  } else {
    services.user.handler(req, res, next);
  }
});
```

This works because **an Express app is itself a valid `(req, res, next)`
middleware function**. Creating a sub-app with `express()` produces a callable
that conforms to the middleware signature, which means:

- `serv.addTo(handler)` can mount the grafserv routes onto the sub-app (since
  `handler` is an `Express` instance).
- The switching middleware can invoke `handler(req, res, next)` as if it were a
  plain function.

This is a well-known Express pattern known as
["sub-apps"](https://expressjs.com/en/4x/api.html#app.mountpath) - mounting one
Express application inside another.

## Is there a strong technical reason?

**Not particularly.** The use of `express()` sub-apps is primarily a consequence
of the `addTo()` API requiring an `Express` instance. The underlying request
handler (`_createHandler()`) returns a standard `(req, res, next)` function that
does not depend on Express-specific features. In theory, a plain handler function
would suffice for the single-endpoint case where websockets are already disabled.

However, there are practical reasons why the current pattern exists:

### 1. `addTo()` is the recommended public API

The `NodeGrafservBase` class does expose a `createHandler()` method that returns
a raw `(req, res, next)` function, but it is **deprecated**:

```ts
/**
 * @deprecated Please use serv.addTo instead, so that websockets can be
 * automatically supported
 */
public createHandler(isHTTPS = false): (req, res, next?) => void {
  return this._createHandler(isHTTPS);
}
```

The deprecation exists because `addTo()` handles both HTTP request routing _and_
WebSocket upgrade setup in one call, making it the safer default. Using
`createHandler()` would bypass websocket setup entirely, which is fine when
websockets are disabled but could be a subtle footgun if the configuration
changes later.

### 2. Express sub-apps provide middleware isolation

Even though it is not strictly needed in the example, using `express()` sub-apps
means each service gets its own independent middleware stack. If you later need
to add service-specific middleware (e.g., different authentication, rate limiting,
or logging per schema), each sub-app can be configured independently without
affecting the other.

### 3. Consistency with the `addTo()` API across frameworks

All grafserv adapters (Express, Fastify, Koa, Hono, etc.) follow the same
pattern: `serv.addTo(frameworkApp)`. The Express multiple-schemas example stays
consistent with this pattern. Using the deprecated `createHandler()` would
introduce a different code path that only applies to the Node/Express adapter.

## Potential alternatives

### Alternative 1: Use `createHandler()` directly (deprecated)

If you want to avoid the extra `express()` instances and websockets are disabled,
you _can_ use the deprecated `createHandler()`:

```ts
const services = {
  admin: {
    handler: null as any,
    pgl: postgraphile({
      extends: [commonPreset],
      pgServices: [makePgService({ connectionString: "postgres:///admin" })],
    }),
  },
  user: {
    handler: null as any,
    pgl: postgraphile({
      extends: [commonPreset],
      pgServices: [makePgService({ connectionString: "postgres:///user" })],
    }),
  },
};

// Use createHandler() to get raw middleware functions
for (const service of Object.values(services)) {
  const serv = service.pgl.createServ(grafserv);
  service.handler = serv.createHandler();
}

// Switch between handlers
app.use((req, res, next) => {
  const isAdmin = req.user?.isAdmin;
  if (isAdmin) {
    services.admin.handler(req, res, next);
  } else {
    services.user.handler(req, res, next);
  }
});
```

This avoids the extra `express()` instances but relies on a deprecated method.
Note that `createHandler()` is only available on the Node-based adapters
(`NodeGrafservBase`), not on framework-specific adapters like Fastify or Hono.

### Alternative 2: Extend the `addTo()` API

A future improvement could allow `addTo()` to accept a callback-style target in
addition to framework instances:

```ts
// Hypothetical future API
const handler = await serv.getHandler(); // Returns (req, res, next) => void
```

This would provide a non-deprecated way to get a raw handler without requiring
a framework instance, making the multiple-schemas pattern simpler for cases
where websockets are not needed.

## Summary

| Aspect | `express()` sub-apps | Plain handler functions |
|---|---|---|
| Works with `addTo()` | Yes | No (needs deprecated `createHandler()`) |
| WebSocket support | Automatic via `addTo()` | Not supported |
| Middleware isolation | Yes (each sub-app has own stack) | No |
| Extra dependency overhead | Minimal (Express app is lightweight) | None |
| API stability | Stable, recommended | Deprecated |

The `express()` sub-app pattern is a pragmatic choice driven by the `addTo()`
API design. It is not strictly necessary for the single-endpoint use case, but
it keeps the code on the recommended API path and provides useful middleware
isolation. For most users, the extra `express()` instances add negligible
overhead and the pattern is idiomatic Express.
