/**
 * Multi-tenancy utilities for dynamic schema resolution.
 *
 * When `pgIdentifiers` is set to `"dynamic"`, schema names in SQL
 * identifiers are wrapped with the `PGMT_PREFIX` / `PGMT_SUFFIX`
 * placeholders. At execution time, a `sqlTextTransform` function
 * (set on `PgExecutorContext`) replaces these placeholders with the
 * real tenant schema names.
 *
 * @example
 * ```ts
 * import {
 *   PGMT_PREFIX,
 *   PGMT_SUFFIX,
 *   buildSchemaRemapTransform,
 * } from "graphile-build-pg/multiTenancy";
 *
 * // Template was built against schemas: ['app_schema', 'perf_schema']
 * // Tenant 2 uses: ['t2_app', 't2_perf']
 * const transform = buildSchemaRemapTransform({
 *   app_schema: 't2_app',
 *   perf_schema: 't2_perf',
 * });
 *
 * // In PgExecutorContext:
 * context.sqlTextTransform = transform;
 * ```
 */

/**
 * The prefix added to schema names in dynamic identifier mode.
 * A compiled SQL identifier will look like `"__pgmt_myschema__"`.
 */
export const PGMT_PREFIX = "__pgmt_";

/**
 * The suffix added to schema names in dynamic identifier mode.
 */
export const PGMT_SUFFIX = "__";

/**
 * Build a `sqlTextTransform` function that replaces dynamic schema
 * placeholders with real tenant schema names.
 *
 * @param schemaMap - A mapping from template schema names to real
 *   tenant schema names. E.g. `{ app_public: 'tenant_42_public' }`.
 * @returns A function suitable for `PgExecutorContext.sqlTextTransform`.
 */
export function buildSchemaRemapTransform(
  schemaMap: Record<string, string>,
): (text: string) => string {
  const entries = Object.entries(schemaMap);
  if (entries.length === 0) {
    return (text: string) => text;
  }

  // Pre-compute the search/replace pairs for efficiency.
  // In compiled SQL, the placeholder appears as a quoted identifier:
  //   "__pgmt_original_schema__"
  // We replace it with the quoted real schema name:
  //   "real_schema"
  const replacements: Array<[search: string, replace: string]> = entries.map(
    ([templateSchema, realSchema]) => [
      `"${PGMT_PREFIX}${templateSchema}${PGMT_SUFFIX}"`,
      `"${realSchema}"`,
    ],
  );

  return (text: string): string => {
    let result = text;
    for (let i = 0, l = replacements.length; i < l; i++) {
      const [search, replace] = replacements[i];
      // Use split+join for global replacement (avoids regex escaping issues)
      result = result.split(search).join(replace);
    }
    return result;
  };
}

/**
 * Extracts the original schema names from a list of placeholder schema
 * names. Useful for understanding which schemas were used as the template.
 *
 * @param placeholderSchemas - Array of placeholder schema names
 *   (e.g. `['__pgmt_app_public__', '__pgmt_app_private__']`).
 * @returns Array of original schema names
 *   (e.g. `['app_public', 'app_private']`).
 */
export function extractTemplateSchemaNames(
  placeholderSchemas: string[],
): string[] {
  return placeholderSchemas.map((s) => {
    if (s.startsWith(PGMT_PREFIX) && s.endsWith(PGMT_SUFFIX)) {
      return s.slice(PGMT_PREFIX.length, -PGMT_SUFFIX.length);
    }
    return s;
  });
}
