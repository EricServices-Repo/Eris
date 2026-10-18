type JsonSchema = Record<string, unknown>

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$defs', 'definitions',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format',
  'type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf',
  'properties', 'required', 'additionalProperties', 'items',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'
])

export type ToolArgumentValidation = { ok: true } | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function validateValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key) && !key.startsWith('x-')) {
      errors.push(`${path} uses unsupported schema keyword "${key}"`)
    }
  }
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : null
  if (alternatives) {
    const valid = alternatives.some((candidate) => {
      if (!isRecord(candidate)) return false
      const candidateErrors: string[] = []
      validateValue(value, candidate, path, candidateErrors)
      return candidateErrors.length === 0
    })
    if (!valid) errors.push(`${path} does not match any allowed schema`)
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (oneOf) {
    const validCount = oneOf.filter((candidate) => {
      if (!isRecord(candidate)) return false
      const candidateErrors: string[] = []
      validateValue(value, candidate, path, candidateErrors)
      return candidateErrors.length === 0
    }).length
    if (validCount !== 1) errors.push(`${path} must match exactly one allowed schema`)
  }

  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      if (isRecord(candidate)) validateValue(value, candidate, path, errors)
    }
  }

  const rawType = schema.type
  const types = Array.isArray(rawType)
    ? rawType.filter((type): type is string => typeof type === 'string')
    : typeof rawType === 'string'
      ? [rawType]
      : []
  if (types.length && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${path} must be ${types.join(' or ')}`)
    return
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push(`${path} must be one of: ${schema.enum.map(String).join(', ')}`)
  }
  if ('const' in schema && !Object.is(schema.const, value)) errors.push(`${path} has an invalid value`)

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`)
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} characters`)
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(`${path} must be greater than ${schema.exclusiveMinimum}`)
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push(`${path} must be less than ${schema.exclusiveMaximum}`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} items`)
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) =>
        validateValue(item, schema.items as JsonSchema, `${path}[${index}]`, errors)
      )
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : []
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path} must contain at least ${schema.minProperties} properties`)
    }
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) {
      errors.push(`${path} must contain at most ${schema.maxProperties} properties`)
    }
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}.${key} is required`)
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key]
      if (isRecord(childSchema)) {
        validateValue(child, childSchema, `${path}.${key}`, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`)
      } else if (isRecord(schema.additionalProperties)) {
        validateValue(child, schema.additionalProperties, `${path}.${key}`, errors)
      }
    }
  }
}

export function validateToolArguments(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined
): ToolArgumentValidation {
  if (!schema) return { ok: false, errors: ['No input schema is available for this tool'] }
  const errors: string[] = []
  validateValue(args, schema, 'arguments', errors)
  return errors.length ? { ok: false, errors: [...new Set(errors)].slice(0, 8) } : { ok: true }
}
