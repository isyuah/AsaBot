import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Generate a UUID v4 in both HTTP and HTTPS pages. */
export function createUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(bytes, (byte, index) => {
    // Set the UUID version and variant bits.
    const value = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte
    return value.toString(16).padStart(2, '0')
  }).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
