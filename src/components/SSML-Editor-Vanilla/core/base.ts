/**
 * SSMLEditor — framework-agnostic speech-synthesis markup editor.
 */
import { type SSMLModel, type SSMLEditorValue, type ResolvedAnnotationFeatures } from "../types";
import { type EditorContext, type SSMLEditorOptions, type EditorState } from "./context";
import { resolveFeatures } from "./features";
import { History } from "../model/history";
import { cloneModel } from "../utils/serialize";
import { valueToModel, modelToSSML } from "../utils/ssml";

import { DomService } from "./dom";
import { ImeService } from "./ime";
import { RenderService } from "./render";
import { ActionsService } from "./actions";
import { ClipboardService } from "./clipboard";
import { SelectionService } from "./selection";
import { KeyboardService } from "./keyboard";
import { PointerService } from "./pointer";
import { createEditorState } from "./state";
import { EventBus, type EditorEvents } from "./event-bus";

export class SSMLEditor implements EditorContext {
  // -------------------------------------------------------------------------
  // Construction options
  // -------------------------------------------------------------------------
  hostEl: HTMLElement;
  onChangeCb: (value: SSMLModel) => void;
  styleOpts?: Partial<CSSStyleDeclaration>;
  readOnly: boolean;
  placeholder: string;
  className: string;

  // Root DOM (assigned by DomService.buildDOM)
  container!: HTMLDivElement;
  content!: HTMLDivElement;
  inputHost!: HTMLDivElement;

  // Controlled document bridge
  history!: History<SSMLModel>;

  // Event bus (typed pub/sub for inter-module decoupling)
  bus!: EventBus<EditorEvents>;

  // Feature flags
  Features: ResolvedAnnotationFeatures;

  // Consolidated editor state (see core/state.ts)
  state!: EditorState;

  // Bound handlers (kept as fields so add/removeEventListener match).
  boundKeyDown: (e: KeyboardEvent) => void;
  boundMouseDown: (e: MouseEvent) => void;
  boundDoubleClick: (e: MouseEvent) => void;
  boundContextMenu: (e: MouseEvent) => void;
  boundCopy: (e: ClipboardEvent) => void;
  boundPaste: (e: ClipboardEvent) => void;
  boundDragOver: (e: DragEvent) => void;
  boundDrop: (e: DragEvent) => void;
  boundDocCopy: () => void;
  boundDocCut: () => void;
  boundCompositionStart: (e: CompositionEvent) => void;
  boundCompositionUpdate: (e: CompositionEvent) => void;
  boundCompositionEnd: (e: CompositionEvent) => void;
  boundSelectionChange: () => void;
  boundFocus: () => void;
  boundBlur: (e: FocusEvent) => void;
  boundScroll: () => void;
  boundMouseUp: (e: MouseEvent) => void;
  boundWindowBlur: () => void;
  boundDocMouseDown: (e: MouseEvent) => void;
  boundMouseMove: (e: MouseEvent) => void;
  boundInputHostInput: (e: Event) => void;
  boundBeforeInput: (e: InputEvent) => void;
  boundContentClick: (e: MouseEvent) => void;
  boundContentMouseDown: (e: MouseEvent) => void;
  boundContentMouseOver: (e: MouseEvent) => void;
  boundContentMouseOut: (e: MouseEvent) => void;

  // -------------------------------------------------------------------------
  // Service instances
  // -------------------------------------------------------------------------
  dom!: DomService;
  ime!: ImeService;
  render!: RenderService;
  actions!: ActionsService;
  clipboard!: ClipboardService;
  selection!: SelectionService;
  keyboard!: KeyboardService;
  pointer!: PointerService;

  constructor(options: SSMLEditorOptions) {
    this.hostEl = options.el;
    this.onChangeCb = options.onChange ?? (() => undefined);
    this.styleOpts = options.style;
    this.readOnly = options.readOnly ?? false;
    this.placeholder = options.placeholder ?? "";
    this.className = options.className ?? "";
    this.Features = resolveFeatures(options.features);
    this.state = createEditorState(cloneModel(valueToModel(options.value)));

    this.bus = new EventBus<EditorEvents>();
    this.dom = new DomService(this);
    this.ime = new ImeService(this);
    this.render = new RenderService(this);
    this.actions = new ActionsService(this);
    this.clipboard = new ClipboardService(this);
    this.selection = new SelectionService(this);
    this.keyboard = new KeyboardService(this);
    this.pointer = new PointerService(this);

    this.setupBus();
    this.boundKeyDown = (e) => this.keyboard.handleKeyDown(e);
    this.boundMouseDown = (e) => this.pointer.handleMouseDown(e);
    this.boundDoubleClick = (e) => this.pointer.handleDoubleClick(e);
    this.boundContextMenu = (e) => this.pointer.handleContextMenu(e);
    this.boundCopy = (e) => this.clipboard.handleCopy(e);
    this.boundPaste = (e) => this.clipboard.handlePaste(e);
    this.boundDragOver = (e) => this.clipboard.handleDragOver(e);
    this.boundDrop = (e) => this.clipboard.handleDrop(e);
    this.boundDocCopy = () => this.clipboard.handleDocClipboard();
    this.boundDocCut = () => this.clipboard.handleDocCut();
    this.boundCompositionStart = (e) => this.ime.handleCompositionStart(e);
    this.boundCompositionUpdate = (e) => this.ime.handleCompositionUpdate(e);
    this.boundCompositionEnd = (e) => this.ime.handleCompositionEnd(e);
    this.boundSelectionChange = () => this.selection.syncSelection();
    this.boundFocus = () => {
      this.state.focused = true;
      this.dom.updateContainerClass();
    };
    this.boundBlur = (e: FocusEvent) => {
      this.state.focused = false;
      this.state.composingText = "";
      this.state.flags.doubleClickPending = false;
      const to = e.relatedTarget;
      const internal =
        !!to && to instanceof Node && (to === this.container || this.container.contains(to));
      if (!internal) {
        this.state.flags.rightClickPending = false;
      }
      this.dom.updateContainerClass();
      if (!this.state.flags.pointerDown) {
        this.bus.emit("render:request", { dirty: false });
      }
    };
    this.boundScroll = () => this.selection.scheduleInputHostPosition();
    this.boundMouseUp = (e: MouseEvent) => this.ime.onPointerUp(e);
    this.boundWindowBlur = () => this.ime.finalizePointerGesture();
    this.boundDocMouseDown = (e: MouseEvent) => this.ime.abandonIfExternalPress(e);
    this.boundMouseMove = () => this.ime.onPointerMove();
    this.boundInputHostInput = (e) => this.clipboard.handleInput(e as InputEvent);
    this.boundBeforeInput = (e) => this.ime.handleBeforeInput(e);
    this.boundContentClick = (e) => this.pointer.handleContentClick(e);
    this.boundContentMouseDown = (e) => this.pointer.handleContentMouseDown(e);
    this.boundContentMouseOver = (e) => this.pointer.handleContentMouseOver(e);
    this.boundContentMouseOut = (e) => this.pointer.handleContentMouseOut(e);

    this.history = new History<SSMLModel>(this.state.model, (next) =>
      this.bus.emit("model:change", next),
    );

    this.dom.buildDOM();
    this.dom.attach();
    this.render.render();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setValue(value: SSMLEditorValue): void {
    this.state.model = cloneModel(valueToModel(value));
    this.state.spans = null;
    this.state.cursor = null;
    this.state.composingText = "";
    this.state.render.forceFullRender = true;
    this.history.setValue(this.state.model);
    this.bus.emit("overlay:close");
    this.bus.emit("render:request", { dirty: true });
  }

  setOptions(opts: Partial<SSMLEditorOptions>): void {
    if (opts.features !== undefined) {
      this.Features = resolveFeatures(opts.features);
      this.state.render.forceFullRender = true;
      this.bus.emit("overlay:close");
    }
    if (opts.placeholder !== undefined) {
      this.placeholder = opts.placeholder;
      this.state.render.forceFullRender = true;
    }
    if (opts.className !== undefined) {
      this.className = opts.className;
    }
    if (opts.readOnly !== undefined && opts.readOnly !== this.readOnly) {
      this.readOnly = opts.readOnly;
      this.state.render.forceFullRender = true;
      if (this.readOnly) {
        this.bus.emit("overlay:close");
        this.ime.cancelCaretRender();
        this.bus.emit("cursor:change", null);
        this.bus.emit("selection:change", null);
      }
    }
    this.dom.updateContainerClass();
    this.bus.emit("render:request", { dirty: true });
  }

  getValue(): SSMLModel {
    return cloneModel(this.state.model);
  }

  getSSML(options?: { includeHints?: boolean }): string {
    return modelToSSML(this.state.model, options);
  }

  setSSML(xml: string): void {
    this.setValue(xml);
  }

  focus(): void {
    this.container.focus();
    this.selection.focusInputHost();
  }

  destroy(): void {
    this.ime.cancelCaretRender();
    this.selection.cancelScheduledHostPosition();
    if (this.state.render.idlePaintCancel) {
      this.state.render.idlePaintCancel();
      this.state.render.idlePaintCancel = null;
    }
    this.state.render.paintingChunks = false;
    this.state.render.paintEpoch++;
    if (this.state.flags.compositionRafId) {
      cancelAnimationFrame(this.state.flags.compositionRafId);
      this.state.flags.compositionRafId = 0;
    }
    this.dom.detach();
    this.bus.emit("overlay:close");
    this.bus.clear();
    this.container.remove();
  }

  // -------------------------------------------------------------------------
  // Event bus subscriptions
  // -------------------------------------------------------------------------

  private setupBus(): void {
    this.bus.on("model:change", (model) => {
      this.state.model = model;
      this.onChangeCb(cloneModel(model));
      this.bus.emit("render:request", { dirty: true });
    });

    this.bus.on("render:request", ({ dirty }) => {
      if (dirty) {
        this.render.markContentDirty();
      }
      this.render.render();
    });

    this.bus.on("cursor:change", (c) => {
      this.state.cursor = c;
      if (c && !this.state.flags.pointerDown) {
        this.ime.scheduleCaretRender();
      }
      this.selection.positionInputHostToCursor();
    });

    this.bus.on("selection:change", (spans) => {
      this.state.spans = spans;
      if (spans && spans.length > 0) {
        this.selection.applyLiveHighlight();
      } else {
        this.selection.removeLiveHighlight();
      }
    });

    this.bus.on("overlay:close", () => {
      this.state.overlays.ctxMenuOpen = false;
      if (this.state.overlays.ctxMenu) {
        this.state.overlays.ctxMenu.destroy();
        this.state.overlays.ctxMenu = null;
      }
      this.state.overlays.editing = null;
      this.state.overlays.annTarget = null;
      this.state.overlays.hintTarget = null;
      this.state.overlays.overlapPrompt = null;
      this.state.overlays.crossBoundaryPrompt = null;
      this.state.overlays.bracketTooltip = null;
      this.state.overlays.hoveredHint = null;
      this.state.spans = null;
      this.pointer.cancelAllHoverTimers();
      this.pointer.clearBracketHover();
      this.selection.clearLocalSelection();
      this.bus.emit("render:request", { dirty: false });
    });
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  blurHost(): void {
    this.inputHost?.blur();
    this.state.focused = false;
    this.dom.updateContainerClass();
  }

  modalOpen(): boolean {
    return !!(
      this.state.overlays.editing ||
      this.state.overlays.annTarget ||
      this.state.overlays.hintTarget ||
      this.state.overlays.overlapPrompt ||
      this.state.overlays.crossBoundaryPrompt
    );
  }
}

// Re-export types that consumers (editor.ts / index.ts) need.
export type {
  SSMLEditorOptions,
  EditorContext,
  EditorState,
  EditingState,
  AnnTarget,
  HintTarget,
} from "./context";
