/**
 * icon-map — the static lucide registry.
 *
 * Icon.tsx used to resolve icons by name off `import * as Lucide`, which meant
 * every one of lucide-react's ~1,600 icons survived tree-shaking and landed in
 * the bundle. Naming each import explicitly here is what lets Rollup drop the
 * rest: the JS bundle went from 1,232.87 kB to the size the budget in
 * scripts/analyze-bundle.cjs now guards.
 *
 * GENERATED-ISH: this list was built by scanning src/ for every quoted
 * PascalCase string that matches a real lucide export — literal
 * `<Icon name="X">`, `icon="X"` props, and the lookup tables the views index
 * into at runtime (TYPE_ICON, KIND_GLYPH, ATTACHMENT_ICON, COLUMN_META, ...).
 * The scan is deliberately generous: a name that is missing here degrades to a
 * Circle in the UI, while a name that is present but unused costs a few hundred
 * bytes. Over-inclusion is the cheaper mistake.
 *
 * ADDING AN ICON: add the name below, in both the import and the map. Nothing
 * else needs to change — Icon's public API is unchanged and still takes a plain
 * string. Forgetting this step is caught in dev by Icon's console warning.
 */

import {
  Accessibility, Activity, Archive, ArrowDown,
  ArrowLeft, ArrowRight, ArrowRightFromLine, ArrowRightToLine,
  ArrowUp, AtSign, BadgeCheck, Ban,
  Bell, Blocks, BookOpen, Bot,
  Box, Boxes, Cable, CalendarClock,
  Check, ChefHat, ChevronDown, ChevronLeft,
  ChevronRight, ChevronsDownUp, ChevronsLeft, ChevronsRight,
  ChevronsUpDown, Circle, CircleAlert, CircleCheck,
  CircleDashed, CircleDot, CircleSlash, CircleX,
  ClipboardCheck, ClipboardList, Clock, Code,
  Columns3, Command, Contrast, Copy,
  CornerDownLeft, CornerDownRight, Cpu, Crown,
  Database, Dock, Download, Ellipsis,
  Eye, File, FileArchive, FileCheck,
  FileCode, FileCog, FileDiff, FileImage,
  FileJson, FileSearch, FileStack, FileText,
  FileType, Files, Flag, FlaskConical,
  Folder, FolderCog, FolderGit2, FolderKanban,
  FolderOpen, FolderSearch, FolderTree, Gauge,
  Gavel, GitBranch, GitCommitHorizontal, Globe,
  Grid, Group, Hammer, Home,
  Hourglass, House, Image, ImageOff,
  Inbox, Info, Kanban, Keyboard,
  Layers, Layout, LayoutGrid, LayoutList,
  List, ListChecks, ListX, Loader,
  Lock, Map, Maximize, MessageSquare,
  MessageSquareDashed, MessageSquarePlus, MessagesSquare, Minus,
  Monitor, Moon, MoveRight, Navigation,
  Network, Package, PackageCheck, PackageOpen,
  Palette, PanelBottom, PanelBottomClose, PanelBottomOpen,
  PanelLeft, PanelRight, PanelRightClose, PanelsTopLeft,
  Paperclip, Pencil, Pin, PinOff,
  Play, Plus, PlugZap, Radar, Receipt,
  ReceiptText, RefreshCw, Rocket, RotateCcw,
  Rows3, Rows4, ScrollText, Search,
  SearchCheck, SearchX, Settings, Settings2,
  Shield, ShieldCheck, ShieldPlus, Sidebar,
  SlidersHorizontal, Space, Sparkles, Square,
  SquareDashedMousePointer, SquarePen, SquareTerminal, Sun,
  Table, Telescope, Terminal, ThumbsDown,
  ThumbsUp, Timer, Trash2, TrendingUp,
  TriangleAlert, Type, Unplug, UserRound,
  UserRoundSearch, Users, Waypoints, Workflow,
  Wrench, X,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

/** Lucide's own prop surface, minus the ref plumbing we never use. */
export type LucideLikeProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  absoluteStrokeWidth?: boolean;
};

export type IconComponent = ComponentType<LucideLikeProps>;

const ICONS = {
  Accessibility, Activity, Archive, ArrowDown,
  ArrowLeft, ArrowRight, ArrowRightFromLine, ArrowRightToLine,
  ArrowUp, AtSign, BadgeCheck, Ban,
  Bell, Blocks, BookOpen, Bot,
  Box, Boxes, Cable, CalendarClock,
  Check, ChefHat, ChevronDown, ChevronLeft,
  ChevronRight, ChevronsDownUp, ChevronsLeft, ChevronsRight,
  ChevronsUpDown, Circle, CircleAlert, CircleCheck,
  CircleDashed, CircleDot, CircleSlash, CircleX,
  ClipboardCheck, ClipboardList, Clock, Code,
  Columns3, Command, Contrast, Copy,
  CornerDownLeft, CornerDownRight, Cpu, Crown,
  Database, Dock, Download, Ellipsis,
  Eye, File, FileArchive, FileCheck,
  FileCode, FileCog, FileDiff, FileImage,
  FileJson, FileSearch, FileStack, FileText,
  FileType, Files, Flag, FlaskConical,
  Folder, FolderCog, FolderGit2, FolderKanban,
  FolderOpen, FolderSearch, FolderTree, Gauge,
  Gavel, GitBranch, GitCommitHorizontal, Globe,
  Grid, Group, Hammer, Home,
  Hourglass, House, Image, ImageOff,
  Inbox, Info, Kanban, Keyboard,
  Layers, Layout, LayoutGrid, LayoutList,
  List, ListChecks, ListX, Loader,
  Lock, Map, Maximize, MessageSquare,
  MessageSquareDashed, MessageSquarePlus, MessagesSquare, Minus,
  Monitor, Moon, MoveRight, Navigation,
  Network, Package, PackageCheck, PackageOpen,
  Palette, PanelBottom, PanelBottomClose, PanelBottomOpen,
  PanelLeft, PanelRight, PanelRightClose, PanelsTopLeft,
  Paperclip, Pencil, Pin, PinOff,
  Play, Plus, PlugZap, Radar, Receipt,
  ReceiptText, RefreshCw, Rocket, RotateCcw,
  Rows3, Rows4, ScrollText, Search,
  SearchCheck, SearchX, Settings, Settings2,
  Shield, ShieldCheck, ShieldPlus, Sidebar,
  SlidersHorizontal, Space, Sparkles, Square,
  SquareDashedMousePointer, SquarePen, SquareTerminal, Sun,
  Table, Telescope, Terminal, ThumbsDown,
  ThumbsUp, Timer, Trash2, TrendingUp,
  TriangleAlert, Type, Unplug, UserRound,
  UserRoundSearch, Users, Waypoints, Workflow,
  Wrench, X,
};

/** The names this build actually ships. */
export type IconName = keyof typeof ICONS;

export const ICON_MAP = ICONS as unknown as Readonly<Record<string, IconComponent | undefined>>;

/** Rendered in place of an unknown name, so a typo is a neutral mark, never a hole. */
export const FALLBACK_ICON = Circle as unknown as IconComponent;

/** Every name in the map. Used by tests and tooling; not needed at runtime. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
