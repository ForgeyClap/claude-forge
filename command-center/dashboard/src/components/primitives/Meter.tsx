/**
 * Meter — a thin horizontal progress line. Never a dial, never a donut.
 *
 * tone="accent" is reserved for progress that is actually running; everything
 * else uses the neutral line value, which keeps the ember rationed.
 */

export interface MeterProps {
  /** 0–100. Clamped. */
  value: number;
  label?: string;
  tone?: 'default' | 'accent';
  /** Print the numeric value after the track, in the machine face. */
  showValue?: boolean;
  className?: string;
}

export function Meter({ value, label, tone = 'default', showValue = false, className }: MeterProps) {
  const safe = Number.isFinite(value) ? value : 0;
  const clamped = Math.max(0, Math.min(100, Math.round(safe)));

  const classes = ['fw-meter'];
  if (className) classes.push(className);

  return (
    <div className={classes.join(' ')} data-tone={tone}>
      {label ? <span className="fw-meter__label fw-truncate">{label}</span> : null}
      <div
        className="fw-meter__track"
        role="progressbar"
        aria-label={label ?? 'Progress'}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${clamped}%`}
      >
        <div className="fw-meter__fill" style={{ inlineSize: `${clamped}%` }} />
      </div>
      {showValue ? <span className="fw-meter__value fg-machine">{clamped}%</span> : null}
    </div>
  );
}
