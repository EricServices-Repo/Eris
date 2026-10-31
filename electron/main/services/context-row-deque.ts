/** Chunked recent ring: append/retire touch a bounded block, never shift a whole transcript.
 * Forks share immutable blocks; a write copies only the block being changed. */
export class ContextRowDeque<T> implements Iterable<T> {
  private blocks = new Map<number, readonly T[]>()
  private begin = 0
  private end = 0
  get length() {
    return this.end - this.begin
  }
  get(index: number): T | undefined {
    if (index < 0 || index >= this.length) return undefined
    const absolute = this.begin + index
    return this.blocks.get(Math.floor(absolute / 128))?.[absolute % 128]
  }
  push(value: T) {
    const block = Math.floor(this.end / 128)
    this.blocks.set(block, [...(this.blocks.get(block) ?? []), value])
    this.end++
  }
  drop(count: number) {
    const next = Math.min(this.end, this.begin + count)
    for (let block = Math.floor(this.begin / 128); block < Math.floor(next / 128); block++)
      this.blocks.delete(block)
    this.begin = next
    if (this.begin === this.end) {
      this.blocks.clear()
      this.begin = this.end = 0
    }
  }
  fork() {
    const copy = new ContextRowDeque<T>()
    copy.blocks = new Map(this.blocks)
    copy.begin = this.begin
    copy.end = this.end
    return copy
  }
  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) yield this.get(i)!
  }
  map<U>(fn: (value: T, index: number) => U): U[] {
    return Array.from(this, fn)
  }
  slice(start = 0, end = this.length): T[] {
    const output: T[] = []
    for (
      let i = Math.max(0, start < 0 ? this.length + start : start);
      i < Math.min(end, this.length);
      i++
    )
      output.push(this.get(i)!)
    return output
  }
}
