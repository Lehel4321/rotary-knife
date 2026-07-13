// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { RecipeBook, FACTORY_RECIPES, blankRecipe, sameRecipe } from '../src/engine/RecipeBook';
import { Recipe } from '../src/types';

/**
 * The recipe library: what the operator stores, loads and deletes. A fresh
 * RecipeBook instance re-reads localStorage, so `new RecipeBook()` is exactly
 * what happens when the HMI is reloaded.
 */

const KEY = 'rotaryknife.recipes.v1';
const reload = () => new RecipeBook();
const p400: Recipe = { name: 'P-400', len: 400, spd: 1000, thick: 10, syncMode: 'constant', ratio: 1.0 };

describe('recipe book', () => {
  beforeEach(() => localStorage.clear());

  it('ships with the factory products when nothing is stored yet', () => {
    expect(reload().list().map(r => r.name).sort())
      .toEqual(FACTORY_RECIPES.map(r => r.name).sort());
  });

  it('saves a recipe and still has it after a reload', () => {
    reload().save(p400);
    const after = reload().get('P-400');
    expect(after).toEqual(p400);
  });

  it('saving under the same name overwrites rather than duplicating', () => {
    const book = reload();
    book.save(p400);
    book.save({ ...p400, len: 650 });
    expect(book.list().filter(r => r.name === 'P-400')).toHaveLength(1);
    expect(book.get('P-400')!.len).toBe(650);
  });

  it('renaming before saving keeps both — this is the "save as" path', () => {
    const book = reload();
    book.save(p400);
    book.save({ ...p400, name: 'P-400-FAST', spd: 2000 });
    expect(book.get('P-400')!.spd).toBe(1000);
    expect(book.get('P-400-FAST')!.spd).toBe(2000);
  });

  it('stores a snapshot: mutating the recipe afterwards does not edit the library', () => {
    const book = reload();
    const working = { ...p400 };
    book.save(working);
    working.len = 999;
    expect(book.get('P-400')!.len).toBe(400);
  });

  it('deletes a recipe, and the deletion survives a reload (no factory resurrection)', () => {
    const book = reload();
    for (const r of book.list()) book.remove(r.name);
    expect(book.list()).toHaveLength(0);
    // An empty book is a real state the operator chose — reloading must not
    // quietly bring the factory recipes back.
    expect(reload().list()).toHaveLength(0);
  });

  it('restores the factory products on demand', () => {
    const book = reload();
    book.remove('TEST-400');
    book.restoreFactory();
    expect(book.list().map(r => r.name).sort()).toEqual(FACTORY_RECIPES.map(r => r.name).sort());
    expect(reload().list()).toHaveLength(FACTORY_RECIPES.length);
  });

  it('falls back to the factory products when storage is corrupt', () => {
    localStorage.setItem(KEY, '{not json');
    expect(reload().list()).toHaveLength(FACTORY_RECIPES.length);
  });

  it('drops malformed entries but keeps the good ones', () => {
    localStorage.setItem(KEY, JSON.stringify([p400, { name: 'BROKEN' }, null, { ...p400, name: 'X', len: 'oops' }]));
    expect(reload().list().map(r => r.name)).toEqual(['P-400']);
  });

  it('notifies subscribers on save and delete', () => {
    const book = reload();
    let n = 0;
    const off = book.subscribe(() => n++);
    book.save(p400);
    book.remove('P-400');
    expect(n).toBe(2);
    off();
    book.save(p400);
    expect(n).toBe(2); // unsubscribed
  });

  it('sameRecipe spots every edited field (this drives the SAVED / MODIFIED badge)', () => {
    expect(sameRecipe(p400, { ...p400 })).toBe(true);
    expect(sameRecipe(p400, { ...p400, len: 401 })).toBe(false);
    expect(sameRecipe(p400, { ...p400, spd: 1001 })).toBe(false);
    expect(sameRecipe(p400, { ...p400, thick: 11 })).toBe(false);
    expect(sameRecipe(p400, { ...p400, ratio: 1.05 })).toBe(false);
    expect(sameRecipe(p400, { ...p400, syncMode: 'comp' })).toBe(false);
    expect(sameRecipe(p400, { ...p400, name: 'OTHER' })).toBe(false);
  });

  it('the blank recipe for NEW is valid product data', () => {
    const b = blankRecipe();
    expect(b.len).toBeGreaterThan(0);
    expect(b.spd).toBeGreaterThan(0);
    expect(b.thick).toBeGreaterThan(0);
    expect(['constant', 'comp']).toContain(b.syncMode);
  });
});
