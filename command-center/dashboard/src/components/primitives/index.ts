/**
 * The Forge Workspace primitive layer.
 *
 * Import everything from here:
 *   import { Button, Panel, StatusBadge } from '@/components/primitives';
 *
 * This module also pulls in primitives.css, so a view never has to remember to.
 */

import './primitives.css';

export { Icon } from './Icon';
export type { IconProps, IconSize } from './Icon';

export { statusPresentation } from './status-presentation';
export type { StatusPresentation } from './status-presentation';

export { StatusBadge } from './StatusBadge';
export type { StatusBadgeProps } from './StatusBadge';

export { StatusDot } from './StatusDot';
export type { StatusDotProps } from './StatusDot';

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';

export { Toolbar, ToolbarGroup, Spacer } from './Toolbar';
export type { ToolbarProps, ToolbarGroupProps, SpacerProps } from './Toolbar';

export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl';

export { Meter } from './Meter';
export type { MeterProps } from './Meter';

export { Machine } from './Machine';
export type { MachineProps } from './Machine';

export { Eyebrow } from './Eyebrow';
export type { EyebrowProps } from './Eyebrow';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Field } from './Field';
export type { FieldProps } from './Field';

export { Switch } from './Switch';
export type { SwitchProps } from './Switch';

export { Tabs, TabPanel } from './Tabs';
export type { TabsProps, TabPanelProps, TabItem } from './Tabs';

export { KeyHint } from './KeyHint';
export type { KeyHintProps } from './KeyHint';

export { Avatar } from './Avatar';
export type { AvatarProps } from './Avatar';

export { Modal } from './Modal';
export type { ModalProps } from './Modal';

export { ExampleTag } from './ExampleTag';
export type { ExampleTagProps } from './ExampleTag';
