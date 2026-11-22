// The part of the look a page needs before any of the app has loaded. Kept apart from
// lib/look.tsx, which is the browser's code: the document itself (app/layout.tsx) reads this.

/** Where the picked look is kept on this device (lib/look.tsx picks it, and wears it after). */
export const LOOK_KEY = "auni:look";

/**
 * Script the document runs before it first paints, so a picked look is worn from the first
 * frame, never the system's for a moment and then the owner's.
 */
export const WEAR_LOOK_FIRST = `try{var l=localStorage.getItem(${JSON.stringify(LOOK_KEY)});if(l)document.documentElement.dataset.theme=l}catch(e){}`;
