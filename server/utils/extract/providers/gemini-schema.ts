// Translates the canonical JSON-Schema used by extractByLlm's universal auction schema
// into Gemini's native `responseSchema` format — an OpenAPI-3.0 subset that
// differs in a few load-bearing ways: uppercase type names, `nullable: true`
// instead of a `type: [x, 'null']` union, no `null` entry inside `enum`, and
// no `additionalProperties` support at all.

type JsonSchema = Record<string, unknown>

const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
}

export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
  const nullable = rawTypes.includes('null')
  const type = rawTypes.find((t): t is string => typeof t === 'string' && t !== 'null')

  const out: JsonSchema = {}
  if (type) out.type = TYPE_MAP[type] ?? type.toUpperCase()
  if (nullable) out.nullable = true
  if (typeof schema.description === 'string') out.description = schema.description
  if (Array.isArray(schema.enum)) out.enum = schema.enum.filter((v) => v !== null)

  if (type === 'object' && schema.properties && typeof schema.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, JsonSchema>).map(([key, value]) => [
        key,
        toGeminiSchema(value),
      ]),
    )
    if (Array.isArray(schema.required)) out.required = schema.required
    // additionalProperties intentionally dropped — unsupported by Gemini's schema subset.
  }
  if (type === 'array' && schema.items && typeof schema.items === 'object') {
    out.items = toGeminiSchema(schema.items as JsonSchema)
  }
  return out
}
