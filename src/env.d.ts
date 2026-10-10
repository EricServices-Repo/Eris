import type { IdeApi } from './shared/api'

declare global {
  interface Window {
    ide: IdeApi
  }
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

export {}
