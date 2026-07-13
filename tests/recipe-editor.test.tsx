// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RecipeModal } from '../src/components/Modals';
import { engine, toMMin } from '../src/engine/SimulationEngine';
import { recipeBook } from '../src/engine/RecipeBook';

/**
 * The operator's recipe workflow, driven through the real DOM: edit a value,
 * see that the machine took it, SAVE it into the library, load another one
 * back. This is the flow that did not exist before — the editor changed the
 * machine's product data but there was no way to store or recall it.
 */

const openEditor = () => render(<RecipeModal onClose={() => {}} />);
const btn = (name: RegExp) => screen.getByRole('button', { name });
const status = () => screen.getByText(/SAVED|MODIFIED|NOT IN LIBRARY/).textContent ?? '';
/** Native `disabled` — no jest-dom matchers needed. */
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const optionsOf = (el: HTMLElement) => [...(el as HTMLSelectElement).options].map(o => o.value);

/** Type into a field and leave it — the editor commits on blur, not per keystroke. */
function setField(label: RegExp, value: string) {
  const el = screen.getByLabelText(label);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}

beforeEach(() => {
  localStorage.clear();
  recipeBook.restoreFactory();
  engine.setRun(false);
  engine.state.controlOn = false;
  engine.updateRecipe({ name: 'TEST-400', len: 400, spd: 1000, thick: 10, syncMode: 'constant', ratio: 1.0 });
});
afterEach(cleanup);

describe('recipe editor — editing', () => {
  it('commits an edited field to the machine when the field is left', () => {
    openEditor();
    setField(/cut length/i, '650');
    expect(engine.recipe.len).toBe(650);
  });

  it('lets you clear a field and retype it without it snapping back', () => {
    openEditor();
    const el = screen.getByLabelText(/cut length/i) as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '' } });   // mid-typing: field is empty
    expect(el.value).toBe('');                          // and STAYS empty
    fireEvent.change(el, { target: { value: '250' } });
    fireEvent.blur(el);
    expect(engine.recipe.len).toBe(250);
  });

  it('clamps a value the machine cannot cut', () => {
    openEditor();
    setField(/cut length/i, '99999');
    expect(engine.recipe.len).toBe(5000); // recipe maximum
  });

  it('rebuilds the cam when the recipe changes', () => {
    openEditor();
    setField(/cut length/i, '800');
    expect(engine.cam.L).toBe(800); // cam period follows the cut length
  });

  it('shows the line speed in m/min and stores it in mm/s', () => {
    openEditor();
    setField(/line speed/i, '30');
    expect(toMMin(engine.recipe.spd)).toBeCloseTo(30, 6);
    expect(engine.recipe.spd).toBeCloseTo(500, 6);
  });
});

describe('recipe editor — the library', () => {
  it('starts on a stored recipe and says so', () => {
    openEditor();
    expect(status()).toMatch(/SAVED/);
    expect(isDisabled(btn(/^save/i))).toBe(true); // nothing to save yet
  });

  it('flags unsaved edits, then saves them into the library', () => {
    openEditor();
    setField(/cut length/i, '650');
    expect(status()).toMatch(/MODIFIED/);
    expect(isDisabled(btn(/^save/i))).toBe(false);

    fireEvent.click(btn(/^save/i));
    expect(recipeBook.get('TEST-400')!.len).toBe(650);
    expect(status()).toMatch(/SAVED/);
    expect(isDisabled(btn(/^save/i))).toBe(true); // nothing left to save
  });

  it('renaming then saving stores a copy and keeps the original', () => {
    openEditor();
    setField(/name/i, 'PROFILE-X');
    setField(/cut length/i, '900');
    expect(status()).toMatch(/NOT IN LIBRARY/);

    fireEvent.click(btn(/^save/i));
    expect(recipeBook.get('PROFILE-X')!.len).toBe(900);
    expect(recipeBook.get('TEST-400')!.len).toBe(400); // original untouched
  });

  it('loads a stored recipe back into the machine', () => {
    openEditor();
    fireEvent.change(screen.getByLabelText(/stored recipes/i), { target: { value: 'THICK-BOARD-800' } });
    fireEvent.click(btn(/^load$/i));

    expect(engine.recipe.name).toBe('THICK-BOARD-800');
    expect(engine.recipe.len).toBe(800);
    expect(engine.recipe.thick).toBe(18);
    expect(engine.recipe.syncMode).toBe('comp');
    expect(engine.cam.L).toBe(800); // the cam was rebuilt for it
    expect(status()).toMatch(/SAVED/);
  });

  it('NEW starts a fresh product that is not in the library yet', () => {
    openEditor();
    fireEvent.click(btn(/^new$/i));
    expect(engine.recipe.name).toBe('NEW-RECIPE');
    expect(status()).toMatch(/NOT IN LIBRARY/);

    fireEvent.click(btn(/^save new$/i));
    expect(recipeBook.has('NEW-RECIPE')).toBe(true);
  });

  it('NEW twice does not overwrite the first one', () => {
    openEditor();
    fireEvent.click(btn(/^new$/i));
    fireEvent.click(btn(/^save new$/i));
    fireEvent.click(btn(/^new$/i));
    expect(engine.recipe.name).toBe('NEW-RECIPE-2');
  });

  it('deletes the selected recipe from the library', () => {
    openEditor();
    fireEvent.change(screen.getByLabelText(/stored recipes/i), { target: { value: 'THIN-FILM-250' } });
    fireEvent.click(btn(/^delete$/i));
    expect(recipeBook.has('THIN-FILM-250')).toBe(false);
    expect(optionsOf(screen.getByLabelText(/stored recipes/i))).not.toContain('THIN-FILM-250');
  });

  it('offers RESTORE FACTORY once the operator has deleted everything', () => {
    openEditor();
    const stored = recipeBook.list().length;
    for (let i = 0; i < stored; i++) fireEvent.click(btn(/^delete$/i));
    expect(recipeBook.list()).toHaveLength(0);
    expect(screen.getByText(/library empty/i)).toBeTruthy();

    fireEvent.click(btn(/restore factory/i));
    expect(recipeBook.list()).toHaveLength(stored);
    expect(optionsOf(screen.getByLabelText(/stored recipes/i))).toContain('TEST-400');
  });
});

describe('recipe editor — interlock while running', () => {
  beforeEach(() => {
    engine.state.controlOn = true;
    engine.setRun(true);
  });
  afterEach(() => { engine.setRun(false); engine.state.controlOn = false; });

  it('locks the fields AND the library buttons while the machine runs', () => {
    openEditor();
    expect(isDisabled(screen.getByLabelText(/cut length/i))).toBe(true);
    expect(isDisabled(screen.getByLabelText(/stored recipes/i))).toBe(true);
    for (const name of [/^load$/i, /^delete$/i, /^new$/i, /^save/i]) {
      expect(isDisabled(btn(name))).toBe(true);
    }
    expect(screen.getByText(/Machine running/i)).toBeTruthy();
  });

  it('refuses a recipe change while running even if a field is forced', () => {
    openEditor();
    expect(engine.updateRecipe({ len: 1234 })).toBe(false);
    expect(engine.recipe.len).toBe(400);
  });
});
