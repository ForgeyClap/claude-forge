/**
 * Ambient declaration so `import './something.css'` type-checks.
 *
 * tsconfig has `noUncheckedSideEffectImports: true`, which makes a bare
 * side-effect import an error unless the module is declared somewhere. Vite
 * handles the import fine at runtime; TypeScript just needs to be told the
 * module exists.
 *
 * This is the shorthand form on purpose. It was verified to coexist without
 * conflict with `/// <reference types="vite/client" />` (which declares the
 * same specifier with a body), so a shell-level src/vite-env.d.ts can be added
 * later without a duplicate-declaration error.
 */
declare module '*.css';
