import { credentialStore } from './credential-store'
export const getSecret = (key: string): string | null => credentialStore.get(key)
export const storeSecret = (key: string, value: string): void => credentialStore.set(key, value)
