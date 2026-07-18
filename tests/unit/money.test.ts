import { describe, it, expect } from 'vitest'
import { currencyDecimals, minorToMajor, moneyFromMinor, type Money } from '../../src/shared/money'

describe('currencyDecimals', () => {
  it('defaults to 2 for standard and unlisted currencies', () => {
    expect(currencyDecimals('USD')).toBe(2)
    expect(currencyDecimals('EUR')).toBe(2)
    expect(currencyDecimals('ZZZ')).toBe(2)
  })

  it('returns 0 for zero-decimal currencies (JPY, KRW, …)', () => {
    expect(currencyDecimals('JPY')).toBe(0)
    expect(currencyDecimals('KRW')).toBe(0)
    expect(currencyDecimals('VND')).toBe(0)
  })

  it('returns 3 for three-decimal currencies (BHD, KWD, …)', () => {
    expect(currencyDecimals('BHD')).toBe(3)
    expect(currencyDecimals('KWD')).toBe(3)
    expect(currencyDecimals('OMR')).toBe(3)
  })

  it('is case-insensitive', () => {
    expect(currencyDecimals('jpy')).toBe(0)
    expect(currencyDecimals('bhd')).toBe(3)
  })
})

describe('minorToMajor', () => {
  it('converts USD cents to dollars', () => {
    expect(minorToMajor(4200, 'USD')).toBe(42)
    expect(minorToMajor(4250, 'USD')).toBe(42.5)
  })

  it('leaves zero-decimal currencies unchanged (JPY)', () => {
    expect(minorToMajor(4200, 'JPY')).toBe(4200)
  })

  it('divides three-decimal currencies by 1000 (BHD)', () => {
    expect(minorToMajor(4200, 'BHD')).toBe(4.2)
  })

  it('treats an unknown currency as 2-decimal', () => {
    expect(minorToMajor(4200, 'ZZZ')).toBe(42)
  })

  it('coerces non-finite input to 0 (never throws)', () => {
    expect(minorToMajor(Number.NaN, 'USD')).toBe(0)
    expect(minorToMajor(Number.POSITIVE_INFINITY, 'USD')).toBe(0)
  })
})

describe('moneyFromMinor', () => {
  it('builds a Money with an upper-cased currency', () => {
    expect(moneyFromMinor(4200, 'usd')).toEqual<Money>({ amount: 42, currency: 'USD' })
    expect(moneyFromMinor(4200, 'jpy')).toEqual<Money>({ amount: 4200, currency: 'JPY' })
  })

  it('produces a scale a same-currency cross-connector comparison expects', () => {
    // Stripe reports minor units; Shopify already reports major units. After
    // conversion both live on the same scale, so the comparison resolves right.
    const stripeRefund = moneyFromMinor(4200, 'USD') // $42.00
    const shopifyTotal = 42.5 // Shopify major-unit number
    expect(stripeRefund.amount).toBeLessThan(shopifyTotal)
    expect(stripeRefund.currency).toBe('USD')
  })
})
