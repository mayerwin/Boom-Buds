// My schemes: the schemes made with the scheme editor, kept in this browser (localStorage), to play, export
// (the original's .SCH text, or all of them in one file) and import, e.g. on another device.

import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { Modal } from './ui.tsx';
import { schemeLabel } from './rules.tsx';
import { allSchemes, clearCustomSchemes, deleteCustomScheme, loadCustomSchemes, saveCustomScheme, schemeKey } from '../app/schemes.ts';

/** The file with all schemes: {format, version, schemes: {FILE.SCH: text}} */
const BUNDLE = 'boombuds-schemes';

function download(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Does this look like a scheme file (it has field rows)? */
function looksLikeScheme(text: string): boolean {
  return /^\s*-R\s*,/m.test(text);
}

export function MySchemes(props: { onClose: () => void; onPlay: (file: string) => void }): JSX.Element {
  const { g, toast, save } = useMenu();
  const [, redraw] = useState(0);
  const [sure, setSure] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const custom = loadCustomSchemes();
  const files = Object.keys(custom).sort();
  const names = new Map(allSchemes(g.app).map((s) => [s.file.toUpperCase(), s.name]));

  /** The current scheme was one of those removed: back to a shipped one. */
  const keepCurrentValid = () => {
    const st = g.settings;
    if (!allSchemes(g.app).some((s) => s.file.toUpperCase() === schemeKey(st.schemefilename))) {
      st.schemefilename = 'BASIC.SCH';
      save();
    }
  };

  const importFiles = async (list: FileList | null) => {
    let n = 0;
    for (const f of [...(list ?? [])]) {
      const text = await f.text();
      if (f.name.toLowerCase().endsWith('.json')) {
        try {
          const b = JSON.parse(text) as { schemes?: Record<string, unknown> };
          for (const [file, t] of Object.entries(b.schemes ?? {})) if (typeof t === 'string' && looksLikeScheme(t) && saveCustomScheme(file, t)) n++;
        } catch {
          toast(`${f.name} is not a scheme file`, true);
        }
      } else if (looksLikeScheme(text)) {
        if (saveCustomScheme(f.name, text)) n++;
      } else toast(`${f.name} is not a scheme file`, true);
    }
    if (n) toast(`${n} scheme${n > 1 ? 's' : ''} imported`);
    if (input.current) input.current.value = '';
    redraw((x) => x + 1);
  };

  return (
    <Modal title="My schemes" onClose={props.onClose} wide>
      <div class="small muted">
        Schemes you save in the Scheme editor are kept in this browser. They come first, with a ★, in the scheme list of
        Local Game and network games (the host's scheme is sent to the other players). Export them to keep a copy or to
        play them on another device.
      </div>
      {files.length === 0 ? (
        <div class="empty">No scheme of yours yet. Make one with the Scheme editor, or import .SCH files.</div>
      ) : (
        <div class="gamelist">
          {files.map((file) => (
            <div class="game-item">
              <div class="grow">
                <b>★ {schemeLabel(names.get(file) ?? file).title}</b>
                <div class="small muted">{file}</div>
              </div>
              <button class="btn primary small" onClick={() => props.onPlay(file)}>Play</button>
              <button class="btn small" onClick={() => download(file, custom[file])}>Export</button>
              <button
                class="btn small ghost"
                onClick={() => {
                  deleteCustomScheme(file);
                  keepCurrentValid();
                  redraw((x) => x + 1);
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      <div class="row">
        <button class="btn small" onClick={() => input.current?.click()}>Import .SCH files…</button>
        {files.length > 0 && (
          <button
            class="btn small"
            onClick={() => download(`${BUNDLE}.json`, JSON.stringify({ format: BUNDLE, version: 1, schemes: custom }, null, 1), 'application/json')}
          >
            Export all
          </button>
        )}
        {files.length > 0 && (
          <button
            class="btn small ghost"
            onClick={() => {
              if (!sure) return setSure(true);
              clearCustomSchemes();
              keepCurrentValid();
              setSure(false);
              toast('Your schemes were deleted');
            }}
          >
            {sure ? 'Sure? Delete them all' : 'Delete all'}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept=".sch,.SCH,.json" multiple hidden onChange={(e) => void importFiles((e.target as HTMLInputElement).files)} />
    </Modal>
  );
}
