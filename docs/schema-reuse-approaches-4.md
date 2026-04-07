# Approach 4 Deep Dive: Schema Pool with `search_path` in Constructive

## Summary

This document evaluates the feasibility of **Approach 4 (Schema Pool
with Warm Cache + `search_path`)** from `docs/schema-reuse-approaches.md`
against the real Constructive codebase. It traces how tenant schemas are
named, how PostGraphile instances are created and cached, how the
`InflektPlugin` already strips schema prefixes, and where `search_path`
would need to be wired in. The conclusion is that `search_path` is
**conditionally viable** but requires resolving cross-schema table name
collisions and making targeted changes in both Crystal and Constructive.

---

## Constructive's current multi-tenant architecture

### Schema naming convention

Constructive uses pgpm (PostgreSQL Package Manager) to manage database
schemas as versioned modules. Each tenant application creates schemas
following the pattern:

```
{extension_name}_{logical_schema_name}
```

For example, an application named `pets` produces:

- `pets_public` (public-facing tables)
- `pets_private` (internal tables)

A second application named `agent_db` produces:

- `agent_db_auth_public`
- `agent_db_users_public`
- `agent_db_storage_public`

The `metaschema_public.schema` table tracks both the **logical name**
(`name` column, e.g. `"public"`, `"private"`) and the **physical schema
name** (`schema_name` column, e.g. `"pets_public"`, `"pets_private"`).

When exporting modules, `makeReplacer()` in `pgpm/export` converts
physical schema names using:

```typescript
toSnakeCase(`${prefix}_${schema.name}`)
```

This means two structurally identical tenants (same blueprint, same
table layout) differ only in their `{extension_name}` prefix:

```
Tenant A: app_a_auth_public, app_a_users_public
Tenant B: app_b_auth_public, app_b_users_public
```

### How PostGraphile instances are created per tenant

The request lifecycle in `graphql/server/src/middleware/` works as
follows:

1. **API middleware** (`api.ts`): resolves the tenant via domain lookup
   or header-based routing. Queries `services_public.apis` joined with
   `services_public.api_schemas` to determine:
   - `dbname`: which PostgreSQL database to connect to
   - `schema`: array of schema names to expose (e.g.
     `["pets_public", "pets_private"]`)
   - `roleName`, `anonRole`: database roles for RLS

2. **Graphile middleware** (`graphile.ts`): checks the `graphileCache`
   (LRU, max 15 entries by default) for a cached PostGraphile instance
   matching the tenant's cache key. On miss:

   ```typescript
   const pool = getPgPool(pgConfig);  // from pg-cache
   const preset = buildPreset(pool, schema, anonRole, roleName);
   const instance = await createGraphileInstance({ preset, cacheKey });
   graphileCache.set(key, instance);
   ```

3. **`buildPreset()`** creates a `GraphileConfig.Preset` that extends
   `ConstructivePreset` and passes tenant-specific schemas to
   `makePgService({ pool, schemas })`.

4. **`createGraphileInstance()`** (in `graphile-cache`) calls
   `postgraphile(preset)` which triggers the full Crystal build
   pipeline: `gather` → `buildSchema` → operation plan caching.

**Each tenant currently gets its own full PostGraphile instance.** The
LRU cache mitigates startup cost but does not share schema structure
across tenants.

### The `InflektPlugin`'s `_schemaPrefix` override

A critical finding: the `InflektPlugin` in
`graphile-settings/src/plugins/custom-inflector.ts` already overrides
Crystal's `_schemaPrefix` inflector to **always return an empty string**:

```typescript
_schemaPrefix(_previous, _options, _details) {
  return '';
}
```

This means all GraphQL type names are already **schema-prefix-free**.
A table `pets_public.owners` and `agent_db_users_public.owners` both
produce the GraphQL type `Owner` (not `PetsPublicOwner`).

The `ConflictDetectorPlugin` exists to warn when this causes naming
collisions between tables in different schemas within the same tenant.

### Per-request session variables

The `buildPreset()` function already uses `grafast.context` to inject
per-request `pgSettings`:

```typescript
context: (requestContext) => ({
  pgSettings: {
    role: roleName,
    'jwt.claims.user_id': req.token?.user_id,
    'jwt.claims.database_id': req.databaseId,
    // ...
  },
})
```

PostGraphile applies these as `SET LOCAL` statements on the database
connection for each request. This is the same mechanism that would be
used to set `search_path`.

### Infrastructure schemas

Constructive maintains several shared infrastructure schemas that are
**not tenant-prefixed**:

- `metaschema_public` — schema/table/field metadata
- `services_public` — API routing, domains, site config
- `db_migrate` — migration tracking

These schemas are not exposed through the tenant's GraphQL API (they
are queried internally by the API middleware). They would need to remain
on the `search_path` but do not participate in the structural
fingerprinting.

---

## Feasibility analysis

### Question 1: Do tenants have cross-schema table name collisions?

**Answer: It depends on the application design, but collisions are
possible.**

The `ConflictDetectorPlugin` exists specifically because Constructive
strips schema prefixes and collisions can occur. Two scenarios:

1. **Within a single tenant** — if `auth_public` and `users_public`
   both have a table named `accounts`, they collide in the GraphQL
   schema. The `ConflictDetectorPlugin` warns about this at schema build
   time.

2. **Across schemas exposed via the same API** — the `api_schemas` table
   determines which schemas are exposed. If an API exposes both
   `_public` and `_private` schemas, any table name appearing in both
   would collide.

For `search_path` to work, **table names must be unique across all
schemas on the path**. If Constructive enforces this convention (which
the `ConflictDetectorPlugin` already encourages), then `search_path` is
viable.

**Risk level: Medium.** The convention exists but is not enforced at the
database level. A validation step during schema creation (in pgpm's
`provision_table`) could enforce uniqueness across sibling schemas.

### Question 2: Can Constructive set `search_path` per-connection?

**Answer: Yes, straightforwardly.**

The `pgSettings` mechanism in `buildPreset()` already supports arbitrary
session variables. Adding `search_path` is a one-line change:

```typescript
pgSettings: {
  role: roleName,
  search_path: schemas.join(', '),
  'jwt.claims.user_id': req.token?.user_id,
  // ...
}
```

PostGraphile translates `pgSettings` keys into `SET LOCAL` calls:

```sql
SET LOCAL search_path TO 'app_a_users_public', 'app_a_auth_public';
```

This is standard PostgreSQL behaviour and is already how RLS roles are
applied per-request in Constructive.

**Risk level: Low.** This is the easiest part of the implementation.

### Question 3: Can `PgCodecsPlugin`/`PgTablesPlugin` emit unqualified identifiers?

**Answer: Not today. This requires Crystal-side changes.**

Currently, Crystal's `PgCodecsPlugin` and `PgTablesPlugin` always emit
schema-qualified SQL identifiers:

```typescript
// PgCodecsPlugin
identifier: sql.identifier(schemaName, tableName)
// e.g. sql.identifier("pets_public", "owners")

// PgTablesPlugin
from: sql.identifier(schemaName, tableName)
```

These identifiers are baked into `PgCodec` and `PgResource` objects
and become part of the cached `OperationPlan`'s compiled SQL.

For `search_path` to work, these would need to emit **unqualified**
identifiers:

```typescript
identifier: sql.identifier(tableName)  // just "owners", no schema
```

This requires either:

- **A configuration option on `makePgService()`** — e.g.
  `useUnqualifiedIdentifiers: true` that tells the gather plugins to
  omit schema qualification
- **An `pg-sql2` compilation hook** — that strips schema qualifiers when
  a flag is set

**Risk level: High.** This is the most invasive change and touches
Crystal core. However, the change is localised to `PgCodecsPlugin` and
`PgTablesPlugin`'s identifier construction, plus the `pg-sql2`
`identifier()` call sites. It does not require changes to the plan
execution model.

### Question 4: Does the OperationPlan cache work with shared schemas?

**Answer: Yes, if the schema is truly shared.**

`OperationPlan` is cached per `GraphQLSchema` instance + operation
document + variable types. If all structurally identical tenants share
the same `GraphQLSchema` object (which they would with this approach),
they also share the `OperationPlan` cache.

The compiled SQL in the `OperationPlan` would contain unqualified
identifiers (e.g. `SELECT "owners"."id" FROM "owners"`). At execution
time, PostgreSQL resolves these via the per-connection `search_path`.

**Risk level: Low.** This is a direct benefit of the approach — no
per-tenant plan compilation.

### Question 5: How do functions and RLS policies interact?

**Answer: Functions on `search_path` resolve correctly, but
schema-qualified function references in policies need care.**

Constructive uses RLS policies extensively. The `RlsModule` in
`graphql/server/src/types.ts` references functions like:

```typescript
{
  authenticate: 'auth_public.authenticate',
  authenticateStrict: 'auth_public.authenticate_strict',
  privateSchema: { schemaName: 'auth_private' },
  publicSchema: { schemaName: 'auth_public' },
  currentRole: 'auth_public.current_role()',
}
```

These function references use **schema-qualified names**. If they are
invoked via SQL (e.g. `SELECT auth_public.current_role()`), the schema
qualification means they work regardless of `search_path`.

However, if any SQL generated by Crystal references functions without
schema qualification, `search_path` must include the function's schema.
In practice, PostGraphile only generates SQL for table operations (not
custom function calls in RLS policies, which are handled by PostgreSQL
itself).

**Risk level: Low.** RLS policies are evaluated by PostgreSQL using the
function's stored schema reference, not the session `search_path`.

---

## Proposed implementation path

### Phase 0: Cross-schema name uniqueness validation

Before implementing `search_path` support, add a validation step to
ensure table names are unique across all schemas exposed by a single
API:

1. **In pgpm's `provision_table`**: check that no other table with the
   same name exists in sibling schemas of the same database. This
   prevents the problem at the source.

2. **Strengthen `ConflictDetectorPlugin`**: upgrade from warning to
   error when duplicate table names are found across schemas in the
   same `pgServices` entry.

3. **Audit existing tenants**: run the fingerprinting analysis from the
   POC report against production data to confirm no existing tenants
   violate the uniqueness constraint.

### Phase 1: Crystal — unqualified identifier mode

Add support in Crystal for emitting unqualified SQL identifiers:

1. **`makePgService()` option**: add a
   `useSearchPathForSchemaResolution: boolean` option that signals to
   gather plugins to omit schema qualification.

2. **`PgCodecsPlugin` change**: when the option is set, construct
   `identifier` as `sql.identifier(tableName)` instead of
   `sql.identifier(schemaName, tableName)`.

3. **`PgTablesPlugin` change**: same treatment for `PgResource.from`.

4. **`PgIntrospectionPlugin`**: continue to introspect with full schema
   awareness (needed for type resolution, relation discovery, etc.).
   The unqualification only affects SQL generation.

5. **`PgProceduresPlugin`**: function calls should remain
   schema-qualified (functions may not be on `search_path`).

Key source locations in Crystal:

| Component | Path |
| --- | --- |
| `PgCodecsPlugin` identifier construction | `graphile-build/graphile-build-pg/src/plugins/PgCodecsPlugin.ts` |
| `PgTablesPlugin` resource.from construction | `graphile-build/graphile-build-pg/src/plugins/PgTablesPlugin.ts` |
| `makePgService` options | `postgraphile/postgraphile/src/adaptors/pg.ts` |
| `_schemaPrefix` inflector | `graphile-build/graphile-build-pg/src/plugins/PgTablesPlugin.ts:261` |

### Phase 2: Constructive — `search_path` integration

Wire `search_path` into the per-request context:

1. **`buildPreset()` in `graphile.ts`**: add `search_path` to
   `pgSettings`:

   ```typescript
   const buildPreset = (
     pool: Pool,
     schemas: string[],
     anonRole: string,
     roleName: string,
   ) => ({
     extends: [ConstructivePreset],
     pgServices: [
       makePgService({
         pool,
         schemas: ['public'],  // canonical schema for introspection
         useSearchPathForSchemaResolution: true,
       }),
     ],
     grafast: {
       context: (requestContext) => {
         // ... existing token/IP extraction ...
         return {
           pgSettings: {
             role: roleName,
             search_path: schemas.join(', '),
             // ... existing claims ...
           },
         };
       },
     },
   });
   ```

2. **Cache key change**: instead of keying the `graphileCache` by
   tenant-specific schemas, key by **structural fingerprint**. All
   tenants with the same fingerprint share one PostGraphile instance.

3. **Pool sharing**: tenants on the same database can share a `pg` pool.
   The `search_path` is set per-connection via `SET LOCAL`, so pool
   sharing is safe.

### Phase 3: Structural fingerprinting in Constructive

Implement fingerprinting so tenants are automatically grouped:

1. **Fingerprint computation**: after resolving the tenant's API config,
   compute a structural fingerprint by normalising schema names (strip
   the extension prefix) and hashing the sorted table/column/constraint
   structure.

2. **Cache key**: use
   `fingerprint:{hash}:db:{dbname}` as the `graphileCache` key instead
   of the current domain/schemata-based key.

3. **Introspection database**: build the shared schema from a
   **canonical tenant** (the first tenant with a given fingerprint).
   Subsequent tenants reuse the cached instance and only differ in
   `search_path`.

---

## Quantitative impact estimate

Based on the memory profiling results from
`docs/postgraphile-memory-layer-profiling-results.md`:

| Metric | Current (per tenant) | With search_path (per fingerprint) |
| --- | --- | --- |
| `makeSchema` init time | ~291 ms | ~291 ms (once) |
| Retained heap per schema | ~3 MB | ~3 MB (shared) |
| `OperationPlan` cache | Per tenant | Shared |
| Per-request overhead | None | ~0.1 ms (`SET LOCAL`) |

For N tenants sharing the same structural fingerprint:

- **Memory saved**: ~3 MB × (N - 1)
- **Init time saved**: ~291 ms × (N - 1)
- **Cache pressure**: `graphileCache` LRU (max 15) now covers 15 ×
  (tenants per fingerprint) effective tenants instead of 15 tenants

With the POC finding that 10 private tenants collapsed to 1 structural
fingerprint, this approach would reduce memory from ~30 MB to ~3 MB and
init time from ~2.9 s to ~291 ms for those tenants.

---

## Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Cross-schema table name collisions break `search_path` resolution | High | Enforce uniqueness in `provision_table`; audit existing tenants |
| Crystal changes to identifier generation break existing plugins | Medium | Feature-flag behind `useSearchPathForSchemaResolution`; no behaviour change when disabled |
| `search_path` ordering affects function/operator resolution | Low | Document required ordering; infrastructure schemas (`metaschema_public`, etc.) are not on the public API path |
| `SET LOCAL search_path` adds per-request latency | Very Low | PostgreSQL handles `SET LOCAL` in < 0.1 ms; negligible compared to query execution |
| Tenants on different databases cannot share PostGraphile instances | N/A | This is expected; the approach only shares instances within the same database |
| Smart tags or per-tenant plugin behaviour differences break sharing | Medium | Fingerprint must include smart tag hashes; only tenants with identical tags share instances |

---

## Comparison with other approaches

| Factor | Approach 4 (search_path) | Approach 5 (Gather cache) | Approach 7 (SQL rewrite) |
| --- | --- | --- | --- |
| Memory saving per tenant | ~3 MB (full schema shared) | ~1.9 MB (gather saved, buildSchema still per-tenant) | ~3 MB (full schema shared) |
| Init time saving per tenant | ~291 ms (full build skipped) | ~62 ms (gather skipped) | ~291 ms (full build skipped) |
| Crystal invasiveness | Medium (identifier generation) | Medium (registry cloning) | Medium-High (SQL post-processing) |
| Constructive invasiveness | Low (pgSettings + cache key) | Medium (registry clone + remap) | Low (SQL interceptor) |
| Correctness guarantee | PostgreSQL-native (`search_path`) | Correct by construction (cloned registry) | Risky (string-based rewriting) |
| Cross-schema collision handling | Requires unique table names | No restriction | No restriction |
| OperationPlan sharing | Yes (same GraphQLSchema) | No (separate GraphQLSchema per tenant) | Yes (same GraphQLSchema) |

---

## Conclusion

Approach 4 is **viable for the Constructive architecture** under the
condition that cross-schema table name uniqueness is enforced. The
`InflektPlugin` already strips schema prefixes, the `pgSettings`
mechanism already supports per-request session variables, and the
`graphileCache` provides a natural integration point.

The main engineering effort is in Crystal (unqualified identifier mode)
rather than Constructive. The Constructive-side changes are minimal:
adding `search_path` to `pgSettings` and changing the cache key to use
structural fingerprints.

**Recommendation**: proceed with Phase 0 (uniqueness validation) to
confirm that existing tenants do not have cross-schema table name
collisions. If confirmed, this approach offers the best
reward-to-effort ratio of all candidates.
