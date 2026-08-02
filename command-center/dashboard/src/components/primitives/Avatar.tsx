/**
 * Avatar — initials in a bordered square. No photographs, no generated faces.
 *
 * Initials are machine-derived from the name, so they use the monospace face.
 * The optional `group` prop tempers the border with the agent-group luminance
 * step, which is a value difference, never a hue.
 */

import type { AgentGroup } from '@/prototype/types/prototype-types';

export interface AvatarProps {
  name: string;
  size?: 'sm' | 'md';
  /** Tempers the border with the agent-group luminance step. */
  group?: AgentGroup;
  /** Set when the name is already rendered next to the avatar. */
  decorative?: boolean;
  className?: string;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, size = 'md', group, decorative = false, className }: AvatarProps) {
  const classes = ['fw-avatar', `fw-avatar--${size}`, 'fg-machine'];
  if (className) classes.push(className);

  return (
    <span
      className={classes.join(' ')}
      data-group={group}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      title={name}
    >
      <span aria-hidden="true">{initialsFor(name)}</span>
    </span>
  );
}
