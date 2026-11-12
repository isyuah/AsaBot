/** A small insertion-ordered LRU set used for recently sent message IDs. */
export class LruSet<T> {
  private readonly values = new Map<T, true>()
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`LRU capacity must be a positive integer, got ${capacity}`)
    }
  }

  add(value: T): void {
    this.values.delete(value)
    this.values.set(value, true)
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next()
      if (oldest.done) {
        break
      }
      this.values.delete(oldest.value)
    }
  }

  has(value: T): boolean {
    if (!this.values.has(value)) {
      return false
    }
    this.values.delete(value)
    this.values.set(value, true)
    return true
  }

  delete(value: T): boolean {
    return this.values.delete(value)
  }

  clear(): void {
    this.values.clear()
  }

  get size(): number {
    return this.values.size
  }
}
