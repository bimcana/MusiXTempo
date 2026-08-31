import { useEffect } from 'react';
import { useApp } from '../state/store';
import { ListenScreen } from './ListenScreen';
import { TapScreen } from './TapScreen';
import { SearchScreen } from './SearchScreen';
import { LibraryScreen } from './LibraryScreen';
import { MetronomeScreen } from './MetronomeScreen';

export default function App() {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  const loadLibrary = useApp((s) => s.loadLibrary);
  const activeSong = useApp((s) => s.songs.find((song) => song.id === s.activeSongId) ?? null);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // El metronomo va a pantalla completa: cuando estas tocando encima de
  // algo no quieres una barra de navegacion pidiendo un toque de mas.
  if (screen === 'metronome' && activeSong) {
    return (
      <main className="safe-top mx-auto min-h-full w-full max-w-lg">
        <MetronomeScreen key={activeSong.id} song={activeSong} />
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <main className="safe-top mx-auto flex w-full max-w-lg flex-1 flex-col">
        {screen === 'listen' && <ListenScreen />}
        {screen === 'tap' && <TapScreen />}
        {screen === 'search' && <SearchScreen />}
        {screen === 'library' && <LibraryScreen />}
      </main>

      <nav className="safe-bottom sticky bottom-0 border-t border-line bg-ground/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-lg">
          <TabButton active={screen === 'listen'} onClick={() => go('listen')} label="Escuchar" />
          <TabButton active={screen === 'tap'} onClick={() => go('tap')} label="Tap" />
          <TabButton active={screen === 'search'} onClick={() => go('search')} label="Buscar" />
          <TabButton active={screen === 'library'} onClick={() => go('library')} label="Biblioteca" />
        </div>
      </nav>
    </div>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        'flex-1 py-3.5 text-xs tracking-[0.1em] uppercase transition-colors sm:text-sm ' +
        (props.active ? 'text-signal' : 'text-muted')
      }
      aria-current={props.active ? 'page' : undefined}
    >
      {props.label}
    </button>
  );
}
