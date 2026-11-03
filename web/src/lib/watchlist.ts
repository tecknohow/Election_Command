import { create } from 'zustand';

/** "My races": race ids starred by this browser (localStorage only; never sent to the server). */
const KEY = 'ec-watchlist-v1';

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200);
  } catch {
    /* storage unavailable */
  }
  return [];
}

function save(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

interface WatchState {
  ids: string[];
  toggle: (id: string) => void;
  clear: () => void;
}

export const useWatchlist = create<WatchState>((set, get) => ({
  ids: load(),
  toggle: (id) => {
    const ids = get().ids.includes(id) ? get().ids.filter((x) => x !== id) : [...get().ids, id];
    save(ids);
    set({ ids });
  },
  clear: () => {
    save([]);
    set({ ids: [] });
  },
}));

export const isWatched = (id: string) => useWatchlist.getState().ids.includes(id);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) useWatchlist.setState({ ids: load() });
  });
}
