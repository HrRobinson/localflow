interface ConsoleProps {
  open: boolean
  onClose: () => void
}

export function Console({ open, onClose }: ConsoleProps): React.JSX.Element | null {
  if (!open) return null
  return (
    <div
      data-console
      className="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-white/10 bg-black/80 backdrop-blur"
      style={{ height: 240 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 text-[12px] text-white/70">
        <span>Console</span>
        <button
          data-console-close
          className="cursor-pointer border-0 bg-transparent text-white/50 hover:text-white"
          onClick={onClose}
          onMouseDown={(e) => e.preventDefault()}
        >
          close
        </button>
      </div>
      <div data-console-list className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" />
    </div>
  )
}
