import type { LocalflowApi } from '../shared/api'

declare global {
  interface Window {
    localflow: LocalflowApi
  }
}

export {}
