/**
 * ExampleTag — the honesty chip.
 *
 * Goes next to anything that looks like evidence but is not: simulated command
 * output, an example test run, a fixture connection state. Small, dashed,
 * muted — it belongs in the detail layer, not stretched across the interface.
 */

import { isProductionMode } from '@/config/mode';
import { Icon } from './Icon';

const DEFAULT_DETAIL =
  'Example data. This prototype is not connected to Forge, Claude Code or any API — nothing here was executed.';

export interface ExampleTagProps {
  /** Overrides the tooltip / screen-reader sentence. */
  detail?: string;
  /** Overrides the visible text. Keep it short and uppercase. */
  text?: string;
  className?: string;
}

/**
 * The whole point of this chip is to mark data that is NOT real. In the
 * connected production build there is no such data — every record comes from the
 * bridge — so the chip renders nothing. Gating it here removes the label at all
 * ~30 call sites at once, and keeps it exactly where it belongs: the
 * fixture-backed theme showcase and the unit tests. A stray EXAMPLE tag on a
 * real record would be its own kind of lie.
 */
export function ExampleTag({ detail = DEFAULT_DETAIL, text = 'EXAMPLE', className }: ExampleTagProps) {
  if (isProductionMode()) return null;

  const classes = ['fw-example-tag'];
  if (className) classes.push(className);

  return (
    <span className={classes.join(' ')} title={detail}>
      <Icon name="FlaskConical" size="xs" className="fw-example-tag__icon" />
      <span className="fw-example-tag__text fg-machine" aria-hidden="true">
        {text}
      </span>
      <span className="fw-visually-hidden">{detail}</span>
    </span>
  );
}
