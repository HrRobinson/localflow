/**
 * Maps a browser pane's stable handle (session id) to its live guest
 * webContents id. The guest webContents is created inside the renderer, but
 * main needs it to drive the pane (loadURL/capturePage/debugger). The renderer
 * reports it on mount via IPC; browser-control resolves handle → id →
 * webContents.fromId(). Cleared on unmount so a closed pane resolves to null
 * (control API then returns 404).
 */
export class BrowserBridge {
  private byHandle = new Map<string, number>()

  register(handle: string, webContentsId: number): void {
    this.byHandle.set(handle, webContentsId)
  }

  unregister(handle: string): void {
    this.byHandle.delete(handle)
  }

  webContentsIdFor(handle: string): number | null {
    return this.byHandle.get(handle) ?? null
  }
}
