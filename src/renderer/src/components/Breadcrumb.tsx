interface Props {
  envName: string
  groupName?: string
  paneName?: string
}

// Renders `envName › groupName › paneName`, dropping whichever of
// groupName/paneName the caller omits (solo pane level: env › pane; session
// level: env › group; grouped pane level: env › group › pane). One text node
// per part, joined with the literal " › " separator — no per-part markup.
export default function Breadcrumb({ envName, groupName, paneName }: Props): React.JSX.Element {
  const parts = [envName, groupName, paneName].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  )
  return (
    <div className="breadcrumb min-w-0 flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap text-gray-400">
      {parts.join(' › ')}
    </div>
  )
}
