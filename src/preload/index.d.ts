import type { SaiifeApi } from '../shared/api'

declare global {
  interface Window {
    saiife: SaiifeApi
  }
}

export {}
