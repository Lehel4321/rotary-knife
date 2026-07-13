import { Recipe } from '../types';

/**
 * RECIPE BOOK — the HMI's recipe storage (the machine's "Rezeptverwaltung").
 *
 * The engine holds exactly ONE recipe: the product data currently loaded into
 * the machine. The book is the shelf next to it — the named products the
 * operator can load, overwrite and delete. It lives on the HMI side (browser
 * localStorage), not in the PLC data blocks, which is also where a real line
 * keeps it.
 *
 * Editing a field in the recipe editor changes the LOADED recipe immediately
 * (the machine is stopped, so that is safe) — it does NOT touch the book until
 * SAVE is pressed. That is the difference the operator has to be able to see:
 * "what the machine will cut" vs "what is stored under this name".
 */

const KEY = 'rotaryknife.recipes.v1';

/** Product data the machine ships with — restored whenever the book is empty. */
export const FACTORY_RECIPES: Recipe[] = [
  { name: 'TEST-400', len: 400, spd: 1000, thick: 10, syncMode: 'constant', ratio: 1.0 },
  { name: 'THIN-FILM-250', len: 250, spd: 1500, thick: 1, syncMode: 'constant', ratio: 1.0 },
  { name: 'THICK-BOARD-800', len: 800, spd: 600, thick: 18, syncMode: 'comp', ratio: 1.0 },
];

/** A blank product for the NEW button. */
export const blankRecipe = (): Recipe => ({
  name: 'NEW-RECIPE', len: 400, spd: 1000, thick: 10, syncMode: 'constant', ratio: 1.0,
});

/** Accept only well-formed records — a corrupt entry must not brick the HMI. */
function isRecipe(v: unknown): v is Recipe {
  const r = v as Recipe;
  return !!r && typeof r.name === 'string' && r.name.length > 0
    && Number.isFinite(r.len) && Number.isFinite(r.spd) && Number.isFinite(r.thick)
    && Number.isFinite(r.ratio) && (r.syncMode === 'constant' || r.syncMode === 'comp');
}

/** Same product data? (Used for the "modified / not saved" indicator.) */
export function sameRecipe(a: Recipe, b: Recipe) {
  return a.name === b.name && a.len === b.len && a.spd === b.spd
    && a.thick === b.thick && a.syncMode === b.syncMode && a.ratio === b.ratio;
}

/** Exported for the tests: a fresh instance re-reads storage, i.e. it models a page reload. */
export class RecipeBook {
  private items: Recipe[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    this.items = this.read();
  }

  /** Stored recipes, alphabetical. */
  public list(): Recipe[] {
    return [...this.items].sort((a, b) => a.name.localeCompare(b.name));
  }

  public get(name: string): Recipe | undefined {
    return this.items.find(r => r.name === name);
  }

  public has(name: string) {
    return this.items.some(r => r.name === name);
  }

  /**
   * Store under the recipe's own name: overwrites the entry with that name,
   * otherwise appends. Renaming a loaded recipe and pressing SAVE therefore
   * stores a copy under the new name — that is "save as".
   */
  public save(r: Recipe) {
    const copy: Recipe = { ...r };
    const i = this.items.findIndex(x => x.name === copy.name);
    if (i >= 0) this.items[i] = copy; else this.items.push(copy);
    this.commit();
  }

  public remove(name: string) {
    this.items = this.items.filter(r => r.name !== name);
    this.commit();
  }

  /** Restore the factory products (used when the book has been emptied). */
  public restoreFactory() {
    this.items = FACTORY_RECIPES.map(r => ({ ...r }));
    this.commit();
  }

  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private commit() {
    this.write();
    this.listeners.forEach(l => l());
  }

  private read(): Recipe[] {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        // An EMPTY book is a legitimate state — the operator deleted every
        // recipe. Only a missing or unreadable book falls back to the factory
        // products; otherwise a deletion would silently undo itself on reload
        // (that is what the explicit RESTORE FACTORY button is for).
        if (Array.isArray(parsed)) return parsed.filter(isRecipe);
      }
    } catch {
      // No storage (private mode / file://) — run from the factory list only.
    }
    return FACTORY_RECIPES.map(r => ({ ...r }));
  }

  private write() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      // Storage unavailable: the book still works for this session.
    }
  }
}

export const recipeBook = new RecipeBook();
