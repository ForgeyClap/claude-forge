/**
 * Forge Workspace — example file tree.
 *
 * The working tree of the barbershop booking build as it would look mid-run,
 * with change markers and a few unified diffs.
 *
 * Nothing here is read from disk. The prototype has no filesystem access; these
 * are hand-written strings that happen to be shaped like a repository.
 */

import type { FileNode } from '@/prototype/types/prototype-types';

export const FILE_TREE: readonly FileNode[] = [
  {
    prototype: true,
    id: 'fn-src',
    name: 'src',
    path: 'src',
    kind: 'dir',
    updatedAt: '2026-07-24 15:45',
    children: [
      {
        prototype: true,
        id: 'fn-src-booking',
        name: 'booking',
        path: 'src/booking',
        kind: 'dir',
        updatedAt: '2026-07-24 15:45',
        children: [
          {
            prototype: true,
            id: 'fn-slots-ts',
            name: 'slots.ts',
            path: 'src/booking/slots.ts',
            kind: 'file',
            changed: 'modified',
            size: '8.4 KB',
            updatedAt: '2026-07-24 15:45',
            diff: `--- a/src/booking/slots.ts
+++ b/src/booking/slots.ts
@@ -142,11 +142,19 @@ export function slotsForDay(
-  // Collapse by service. Two barbers offering the same service used to
-  // produce the same slot twice.
-  const seen = new Set<string>();
-  return raw.filter((slot) => {
-    const key = slot.startsAt + ':' + slot.serviceId;
-    if (seen.has(key)) return false;
-    seen.add(key);
-    return true;
-  });
+  // Collapse by barber, not by service. A slot belongs to a person: two
+  // barbers free at 14:00 are two bookable slots, not one duplicate.
+  const seen = new Set<string>();
+  return raw.filter((slot) => {
+    const key = slot.startsAt + ':' + slot.barberId;
+    if (seen.has(key)) return false;
+    seen.add(key);
+    return true;
+  });
 }`,
          },
          {
            prototype: true,
            id: 'fn-availability-ts',
            name: 'availability.ts',
            path: 'src/booking/availability.ts',
            kind: 'file',
            changed: 'modified',
            size: '6.1 KB',
            updatedAt: '2026-07-24 15:31',
            diff: `--- a/src/booking/availability.ts
+++ b/src/booking/availability.ts
@@ -71,8 +71,12 @@ function fits(service: Service, window: Window): boolean {
-  return service.durationMinutes <= window.lengthMinutes;
+  // Buffer time is not part of the service duration. A 20-minute trim still
+  // needs the chair swept before the next person sits in it.
+  const needed = service.durationMinutes + service.bufferMinutes;
+  return needed <= window.lengthMinutes;
 }`,
          },
          {
            prototype: true,
            id: 'fn-booking-form',
            name: 'BookingForm.tsx',
            path: 'src/booking/BookingForm.tsx',
            kind: 'file',
            changed: 'modified',
            size: '11.7 KB',
            updatedAt: '2026-07-24 14:38',
          },
          {
            prototype: true,
            id: 'fn-slot-grid',
            name: 'SlotGrid.tsx',
            path: 'src/booking/SlotGrid.tsx',
            kind: 'file',
            changed: 'added',
            size: '5.3 KB',
            updatedAt: '2026-07-24 15:16',
          },
          {
            prototype: true,
            id: 'fn-pricing-ts',
            name: 'pricing.ts',
            path: 'src/booking/pricing.ts',
            kind: 'file',
            size: '3.2 KB',
            updatedAt: '2026-07-24 12:04',
          },
          {
            prototype: true,
            id: 'fn-validation-ts',
            name: 'validation.ts',
            path: 'src/booking/validation.ts',
            kind: 'file',
            changed: 'modified',
            size: '4.0 KB',
            updatedAt: '2026-07-24 13:52',
          },
        ],
      },
      {
        prototype: true,
        id: 'fn-src-components',
        name: 'components',
        path: 'src/components',
        kind: 'dir',
        updatedAt: '2026-07-24 15:44',
        children: [
          {
            prototype: true,
            id: 'fn-hero-tsx',
            name: 'Hero.tsx',
            path: 'src/components/Hero.tsx',
            kind: 'file',
            changed: 'added',
            size: '4.6 KB',
            updatedAt: '2026-07-24 15:44',
          },
          {
            prototype: true,
            id: 'fn-service-menu',
            name: 'ServiceMenu.tsx',
            path: 'src/components/ServiceMenu.tsx',
            kind: 'file',
            changed: 'added',
            size: '6.9 KB',
            updatedAt: '2026-07-24 15:44',
          },
          {
            prototype: true,
            id: 'fn-summary-bar',
            name: 'SummaryBar.tsx',
            path: 'src/components/SummaryBar.tsx',
            kind: 'file',
            changed: 'modified',
            size: '3.8 KB',
            updatedAt: '2026-07-24 15:46',
            diff: `--- a/src/components/SummaryBar.tsx
+++ b/src/components/SummaryBar.tsx
@@ -18,7 +18,7 @@ export function SummaryBar({ booking }: Props) {
   return (
-    <div className="bk-summary-bar" role="status">
+    <div className="bk-summary-bar" role="status" data-sticky="true">
       <span className="bk-summary-bar__service">{booking.serviceName}</span>
       <span className="bk-summary-bar__time">{booking.startsAtLabel}</span>
     </div>
   );
 }`,
          },
          {
            prototype: true,
            id: 'fn-step-indicator',
            name: 'StepIndicator.tsx',
            path: 'src/components/StepIndicator.tsx',
            kind: 'file',
            changed: 'modified',
            size: '2.7 KB',
            updatedAt: '2026-07-24 15:16',
          },
        ],
      },
      {
        prototype: true,
        id: 'fn-src-styles',
        name: 'styles',
        path: 'src/styles',
        kind: 'dir',
        updatedAt: '2026-07-24 15:46',
        children: [
          {
            prototype: true,
            id: 'fn-booking-css',
            name: 'booking.css',
            path: 'src/styles/booking.css',
            kind: 'file',
            changed: 'modified',
            size: '9.2 KB',
            updatedAt: '2026-07-24 15:46',
            diff: `--- a/src/styles/booking.css
+++ b/src/styles/booking.css
@@ -204,6 +204,15 @@
 .bk-summary-bar[data-sticky='true'] {
   position: sticky;
   bottom: 0;
 }
+
+/* The slot grid scrolled under the sticky bar and took the confirm button
+   with it. Reserve the bar's height so the last two rows stay reachable. */
+.bk-slot-grid {
+  padding-block-end: calc(var(--bk-summary-bar-height) + 1rem);
+}
+
+@media (prefers-reduced-motion: reduce) {
+  .bk-slot-grid { scroll-behavior: auto; }
+}`,
          },
          {
            prototype: true,
            id: 'fn-hero-css',
            name: 'hero.css',
            path: 'src/styles/hero.css',
            kind: 'file',
            changed: 'added',
            size: '3.4 KB',
            updatedAt: '2026-07-24 15:44',
          },
          {
            prototype: true,
            id: 'fn-type-css',
            name: 'type.css',
            path: 'src/styles/type.css',
            kind: 'file',
            changed: 'modified',
            size: '2.2 KB',
            updatedAt: '2026-07-24 10:58',
          },
        ],
      },
      {
        prototype: true,
        id: 'fn-app-tsx',
        name: 'App.tsx',
        path: 'src/App.tsx',
        kind: 'file',
        changed: 'modified',
        size: '2.9 KB',
        updatedAt: '2026-07-24 14:38',
      },
      {
        prototype: true,
        id: 'fn-main-tsx',
        name: 'main.tsx',
        path: 'src/main.tsx',
        kind: 'file',
        size: '0.6 KB',
        updatedAt: '2026-07-24 10:31',
      },
    ],
  },
  {
    prototype: true,
    id: 'fn-tests',
    name: 'tests',
    path: 'tests',
    kind: 'dir',
    updatedAt: '2026-07-24 14:02',
    children: [
      {
        prototype: true,
        id: 'fn-tests-e2e',
        name: 'e2e',
        path: 'tests/e2e',
        kind: 'dir',
        updatedAt: '2026-07-24 14:02',
        children: [
          {
            prototype: true,
            id: 'fn-e2e-desktop',
            name: 'booking.desktop.spec.ts',
            path: 'tests/e2e/booking.desktop.spec.ts',
            kind: 'file',
            changed: 'modified',
            size: '5.8 KB',
            updatedAt: '2026-07-24 15:08',
          },
          {
            prototype: true,
            id: 'fn-e2e-mobile',
            name: 'booking.mobile.spec.ts',
            path: 'tests/e2e/booking.mobile.spec.ts',
            kind: 'file',
            changed: 'added',
            size: '6.2 KB',
            updatedAt: '2026-07-24 14:02',
            diff: `--- a/tests/e2e/booking.mobile.spec.ts
+++ b/tests/e2e/booking.mobile.spec.ts
@@ -48,6 +48,11 @@ test('full journey at 390x844', async ({ page }) => {
-  await page.getByRole('button', { name: 'Confirm booking' }).click();
+  // "Present in the DOM" is not the same as "a thumb can reach it". Assert
+  // both before clicking, so the failure names the real problem.
+  const confirm = page.getByRole('button', { name: 'Confirm booking' });
+  await expect(confirm).toBeVisible();
+  await expect(confirm).toBeInViewport();
+  await confirm.click();

   await expect(page.getByText('Booking confirmed')).toBeVisible();
 });`,
          },
          {
            prototype: true,
            id: 'fn-e2e-shots',
            name: 'screenshots.spec.ts',
            path: 'tests/e2e/screenshots.spec.ts',
            kind: 'file',
            size: '2.4 KB',
            updatedAt: '2026-07-24 15:12',
          },
        ],
      },
      {
        prototype: true,
        id: 'fn-tests-unit',
        name: 'unit',
        path: 'tests/unit',
        kind: 'dir',
        updatedAt: '2026-07-24 13:36',
        children: [
          {
            prototype: true,
            id: 'fn-unit-slots',
            name: 'slots.test.ts',
            path: 'tests/unit/slots.test.ts',
            kind: 'file',
            changed: 'modified',
            size: '12.9 KB',
            updatedAt: '2026-07-24 13:36',
          },
          {
            prototype: true,
            id: 'fn-unit-pricing',
            name: 'pricing.test.ts',
            path: 'tests/unit/pricing.test.ts',
            kind: 'file',
            size: '4.1 KB',
            updatedAt: '2026-07-24 12:18',
          },
          {
            prototype: true,
            id: 'fn-unit-legacy',
            name: 'legacy-slots.test.ts',
            path: 'tests/unit/legacy-slots.test.ts',
            kind: 'file',
            changed: 'deleted',
            size: '—',
            updatedAt: '2026-07-24 11:47',
          },
        ],
      },
    ],
  },
  {
    prototype: true,
    id: 'fn-docs',
    name: 'docs',
    path: 'docs',
    kind: 'dir',
    updatedAt: '2026-07-24 15:22',
    children: [
      {
        prototype: true,
        id: 'fn-docs-setup',
        name: 'setup.md',
        path: 'docs/setup.md',
        kind: 'file',
        changed: 'modified',
        size: '7.3 KB',
        updatedAt: '2026-07-24 15:22',
      },
      {
        prototype: true,
        id: 'fn-docs-handoff',
        name: 'handoff.md',
        path: 'docs/handoff.md',
        kind: 'file',
        changed: 'added',
        size: '4.8 KB',
        updatedAt: '2026-07-24 15:22',
      },
      {
        prototype: true,
        id: 'fn-docs-decisions',
        name: 'decisions.md',
        path: 'docs/decisions.md',
        kind: 'file',
        changed: 'modified',
        size: '5.5 KB',
        updatedAt: '2026-07-24 14:09',
      },
    ],
  },
  {
    prototype: true,
    id: 'fn-artifacts',
    name: 'artifacts',
    path: 'artifacts',
    kind: 'dir',
    updatedAt: '2026-07-24 15:12',
    children: [
      {
        prototype: true,
        id: 'fn-art-desktop-png',
        name: 'playwright-desktop.png',
        path: 'artifacts/playwright-desktop.png',
        kind: 'file',
        changed: 'added',
        size: '412 KB',
        updatedAt: '2026-07-24 15:12',
      },
      {
        prototype: true,
        id: 'fn-art-mobile-png',
        name: 'playwright-mobile.png',
        path: 'artifacts/playwright-mobile.png',
        kind: 'file',
        changed: 'added',
        size: '286 KB',
        updatedAt: '2026-07-24 14:03',
      },
      {
        prototype: true,
        id: 'fn-art-receipt',
        name: 'build-receipt.txt',
        path: 'artifacts/build-receipt.txt',
        kind: 'file',
        changed: 'added',
        size: '1.3 KB',
        updatedAt: '2026-07-24 14:51',
      },
    ],
  },
  {
    prototype: true,
    id: 'fn-public',
    name: 'public',
    path: 'public',
    kind: 'dir',
    updatedAt: '2026-07-24 10:31',
    children: [
      {
        prototype: true,
        id: 'fn-public-fonts',
        name: 'fonts',
        path: 'public/fonts',
        kind: 'dir',
        updatedAt: '2026-07-24 10:31',
        children: [
          {
            prototype: true,
            id: 'fn-font-display',
            name: 'display-var.woff2',
            path: 'public/fonts/display-var.woff2',
            kind: 'file',
            changed: 'added',
            size: '68 KB',
            updatedAt: '2026-07-24 10:31',
          },
          {
            prototype: true,
            id: 'fn-font-text',
            name: 'text-var.woff2',
            path: 'public/fonts/text-var.woff2',
            kind: 'file',
            changed: 'added',
            size: '74 KB',
            updatedAt: '2026-07-24 10:31',
          },
        ],
      },
      {
        prototype: true,
        id: 'fn-favicon',
        name: 'favicon.svg',
        path: 'public/favicon.svg',
        kind: 'file',
        changed: 'added',
        size: '1.1 KB',
        updatedAt: '2026-07-24 10:44',
      },
    ],
  },
  {
    prototype: true,
    id: 'fn-readme',
    name: 'README.md',
    path: 'README.md',
    kind: 'file',
    changed: 'modified',
    size: '6.7 KB',
    updatedAt: '2026-07-24 14:57',
    diff: `--- a/README.md
+++ b/README.md
@@ -1,10 +1,16 @@
 # Barbershop booking

-A booking site for a barbershop.
+A booking site for a three-chair barbershop: pick a service, pick a time,
+leave a name, done. No account, no redirect, no countdown timer.
+
+## Not finished yet
+
+Two things do not work, and they are named here rather than at the bottom:
+
+- **Deposit payment** — written against the documented contract, never once
+  executed, because no test credentials were provided.
+- **Confirmation email** — renders correctly and cannot be sent; there is no
+  configured sender.

 ## Running it locally`,
  },
  {
    prototype: true,
    id: 'fn-package-json',
    name: 'package.json',
    path: 'package.json',
    kind: 'file',
    changed: 'modified',
    size: '1.8 KB',
    updatedAt: '2026-07-24 13:20',
  },
  {
    prototype: true,
    id: 'fn-env-example',
    name: '.env.example',
    path: '.env.example',
    kind: 'file',
    changed: 'modified',
    size: '0.4 KB',
    updatedAt: '2026-07-24 12:47',
  },
];
