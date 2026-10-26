export interface StorageInventory {
  stores: Array<{
    id: string
    schema: string
    scope: string
    sensitivity: string
    retention: string
    entries: number
    bytes: number
    automatic: boolean
  }>
  scanned: number
  truncated: boolean
  busy: boolean
  failures: Array<{ path: string; message: string; at: number }>
}
export interface StorageCleanup {
  removed: number
  retained: number
  truncated: boolean
}
