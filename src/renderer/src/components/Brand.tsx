/** Toolbar identity: three pane squares in the status colors + wordmark. */
export default function Brand(): React.JSX.Element {
  return (
    <div className="brand" title="localflow">
      <svg className="brand-mark" width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">
        <rect x="0" y="2" width="7" height="12" rx="2" fill="var(--working)" />
        <rect x="9.5" y="0" width="7" height="16" rx="2" fill="var(--needs-you)" />
        <rect x="19" y="4" width="7" height="10" rx="2" fill="var(--idle)" />
      </svg>
      <span className="brand-name">localflow</span>
    </div>
  )
}
