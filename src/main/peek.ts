// Strips ANSI/VT escape sequences per the ECMA-48 grammar: CSI with full
// parameter bytes (covers private-mode like ESC[>0q), OSC titles ended by
// BEL/ST, DCS-family strings, other C1 escapes, and stray control bytes.
// Also covers the 8-bit C1 CSI () form some agents/terminfo emit
// instead of the 7-bit ESC[ prefix — same CSI grammar, single code unit.
// Partial stripping here leaks garbage like "0q4mu" into user messages.

export const ANSI_RE = new RegExp(
  [
    '\\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]',
    '\\u009b[0-9:;<=>?]*[ -/]*[@-~]',
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?',
    '\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?',
    '\\u001b[ -/]+[0-~]',
    '\\u001b[@-Z\\\\-_]',
    '[\\u0000-\\u0008\\u000b-\\u001f\\u007f]'
  ].join('|'),
  'g'
)

/**
 * Last `maxLines` non-empty, ANSI-stripped output lines from a raw pty
 * buffer — the "pending question" peek shown next to an Approve control.
 * Best-effort by design: full-screen TUI redraw frames concatenate after
 * stripping, and bare-\r progress updates collapse (\r is a stripped
 * control byte), but the last screenful an agent printed is what the last
 * few lines land on. Splits on \n only — \r never survives the strip.
 */
export function extractPeekLines(raw: string, maxLines: number): string[] {
  return raw
    .replace(ANSI_RE, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-maxLines)
}
