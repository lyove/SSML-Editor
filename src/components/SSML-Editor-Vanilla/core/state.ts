/**
 * EditorState — centralized, type-safe state for the SSML editor.
 */

import type { Cursor, SelectionSpan, SSMLAnnotation, SSMLModel } from "../types";
import type { ContextMenu } from "../components/context-menu";
import type { CrossBoundaryPrompt, OverlapPrompt } from "../view/overlays";
import type { VNode, VNodeDomRefs } from "../view/vnode";
import type {
  BreakPopover,
  EmphasisPopover,
  ProsodyPopover,
  SayAsPopover,
  HintPopover,
  PhonemePopover,
  PopoverChar,
} from "../components";

// ---------------------------------------------------------------------------
// Internal popover-target state shapes
// ---------------------------------------------------------------------------

/** Phoneme popover target */
export interface EditingState {
  rect: DOMRect;
  chars: PopoverChar[];
  locations: { blockId: string; charIdx: number }[];
}

/** Break / prosody / sayAs / emphasis popover target */
export interface AnnTarget {
  type: SSMLAnnotation["type"];
  rect: DOMRect;
  blockId: string;
  start: number;
  end: number;
  existing: SSMLAnnotation | null;
}

/** Hint popover target */
export interface HintTarget {
  rect: DOMRect;
  blockId: string;
  start: number;
  end: number;
  initialText: string;
}

// ---------------------------------------------------------------------------
// State sub-groups
// ---------------------------------------------------------------------------

/** Overlay / popover / context-menu UI state */
export interface OverlayState {
  ctxMenu: ContextMenu | null;
  ctxMenuOpen: boolean;
  editing: EditingState | null;
  annTarget: AnnTarget | null;
  hintTarget: HintTarget | null;
  overlapPrompt: OverlapPrompt | null;
  crossBoundaryPrompt: CrossBoundaryPrompt | null;
  hoveredPairId: string | null;
  bracketTooltip: { ann: SSMLAnnotation; rect: DOMRect } | null;
  hoveredHint: { el: HTMLElement; text: string } | null;
  hasClipboard: boolean;
  editingPopover: PhonemePopover | null;
  annPopover: BreakPopover | ProsodyPopover | SayAsPopover | EmphasisPopover | null;
  hintPopover: HintPopover | null;
}

/** Incremental block-tree painting & render bookkeeping */
export interface RenderState {
  floatLayer: HTMLDivElement | null;
  contentDirty: boolean;
  paintedEls: Map<string, HTMLElement> | null;
  paintedFingerprints: Map<string, string> | null;
  paintedModel: SSMLModel | null;
  paintedEmpty: boolean;
  forceFullRender: boolean;
  lastSelSpans: SelectionSpan[] | null;
  paintedCaretEl: HTMLElement | null;
  paintedVNodes: Map<string, VNode[]> | null;
  paintedDomRefs: Map<string, VNodeDomRefs> | null;
  idlePaintCancel: (() => void) | null;
  paintingChunks: boolean;
  paintEpoch: number;
}

/** Transient boolean / numeric / pointer flags */
export interface EditorFlags {
  hostPosStale: boolean;
  caretRafId: number;
  compositionRafId: number;
  pointerDown: boolean;
  lastMouseDown: { x: number; y: number; t: number } | null;
  doubleClickPending: boolean;
  rightClickPending: boolean;
  popoverSyncGuard: boolean;
}

// ---------------------------------------------------------------------------
// Top-level EditorState
// ---------------------------------------------------------------------------

export interface EditorState {
  /** The controlled model (mutated only via the `model:change` event from History) */
  model: SSMLModel;
  /** Virtual caret position (was `cursorRef`) */
  cursor: Cursor | null;
  /** Live selection spans for bracket highlight */
  spans: SelectionSpan[] | null;
  /** Cached selection bounding rect */
  selRect: DOMRect | null;
  /** Whether the editor host has focus */
  focused: boolean;
  /** Current IME composition buffer */
  composingText: string;
  /** Whether an IME composition is active (compositionstart -> compositionend) */
  isComposing: boolean;
  /** Popover / context-menu / hover UI state */
  overlays: OverlayState;
  /** Render & incremental painting bookkeeping */
  render: RenderState;
  /** Transient boolean / numeric flags */
  flags: EditorFlags;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the initial `EditorState` with sensible defaults.
 *
 * @param model    The starting document value.
 */
export function createEditorState(model: SSMLModel): EditorState {
  const overlays: OverlayState = {
    ctxMenu: null,
    ctxMenuOpen: false,
    editing: null,
    annTarget: null,
    hintTarget: null,
    overlapPrompt: null,
    crossBoundaryPrompt: null,
    hoveredPairId: null,
    bracketTooltip: null,
    hoveredHint: null,
    hasClipboard: false,
    editingPopover: null,
    annPopover: null,
    hintPopover: null,
  };

  const render: RenderState = {
    floatLayer: null,
    contentDirty: true,
    paintedEls: null,
    paintedFingerprints: null,
    paintedModel: null,
    paintedEmpty: true,
    forceFullRender: false,
    lastSelSpans: null,
    paintedCaretEl: null,
    paintedVNodes: null,
    paintedDomRefs: null,
    idlePaintCancel: null,
    paintingChunks: false,
    paintEpoch: 0,
  };

  const flags: EditorFlags = {
    hostPosStale: true,
    caretRafId: 0,
    compositionRafId: 0,
    pointerDown: false,
    lastMouseDown: null,
    doubleClickPending: false,
    rightClickPending: false,
    popoverSyncGuard: false,
  };

  const state: EditorState = {
    model,
    cursor: null,
    spans: null,
    selRect: null,
    focused: false,
    composingText: "",
    isComposing: false,
    overlays,
    render,
    flags,
  };

  return state;
}
