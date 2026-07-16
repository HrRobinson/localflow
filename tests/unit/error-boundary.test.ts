import { describe, expect, it } from 'vitest'
import { deriveErrorState } from '../../src/renderer/src/components/errorBoundaryState'

// This repo's vitest setup runs in `environment: 'node'` with no jsdom /
// @testing-library/react, and no other renderer component has ever been
// mounted in a test (see error-audit-4-renderer.md finding R1). tests/unit
// also type-checks under tsconfig.node.json (no --jsx), so it can't import
// ErrorBoundary.tsx directly either. Rather than bolt on a DOM harness for a
// single component, we test `deriveErrorState` -- the pure function
// ErrorBoundary.getDerivedStateFromError delegates to -- directly. This is
// exactly the branch that decides whether the fallback (with the thrown
// error's message) renders instead of the crashed children. Full DOM-mount
// coverage of the fallback JSX is a known gap; see PR description.
describe('deriveErrorState (ErrorBoundary.getDerivedStateFromError logic)', () => {
  it('captures a thrown error into state so the fallback can render its message', () => {
    const error = new Error('boom: renderer crashed')

    const state = deriveErrorState(error)

    expect(state.error).toBe(error)
    expect(state.error?.message).toBe('boom: renderer crashed')
  })

  it('always produces an Error-typed state entry', () => {
    const error = new Error('nested crash')

    const state = deriveErrorState(error)

    expect(state.error).toBeInstanceOf(Error)
  })
})
