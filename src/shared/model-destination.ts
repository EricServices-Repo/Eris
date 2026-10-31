/** Pure classification shared by compilation and native runtime adapters. */
export function isNativeGgufRef(model: string): boolean {
  return model.startsWith('builtin:') || model.startsWith('local:')
}
