/**
 * ImeService — IME composition + caret / drag-selection rendering schedule.
 */
import type { EditorContext } from "./context";
import type { Cursor, SelectionSpan, SSMLBlock, SSMLModel } from "../types";
import { blockLen, createBlockId, sanitizeCursor } from "../model/model";
import { insertTextAtCursor, removeSpansFromModel } from "../utils/operations";
import { getSelectionSpans } from "../utils/selection";
import { buildBlockDomRefs, caretInsertionPoint, createCaretSpan } from "../view/block-render";

const TYPING_SEPARATOR_RE = /[\s\p{P}\p{S}]/u;

export class ImeService {
  constructor(private ctx: EditorContext) {}

  private typingRunId = 0;
  private lastTypingText = "";

  handleCompositionStart(e: CompositionEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".se-ctx, .se-popover, .se-popup")) {
      return;
    }
    if (this.ctx.modalOpen()) {
      return;
    }
    this.ensureCursorAtStart();
    this.ctx.state.composingText = "";
    this.ctx.state.isComposing = true;
    this.resetHostCaret();
    this.ctx.selection.positionInputHostToCursor();
  }

  private ensureCursorAtStart(): void {
    const { ctx } = this;
    if (ctx.state.cursor) {
      return;
    }
    const model = ctx.state.model;
    if (model.blocks.length > 0) {
      const first = model.blocks[0];
      ctx.bus.emit("cursor:change", { blockId: first.id, idx: 0 });
      ctx.bus.emit("render:request", { dirty: true });
    } else {
      const blockId = createBlockId();
      ctx.state.model = { ...model, blocks: [{ id: blockId, text: "" }] };
      ctx.bus.emit("cursor:change", { blockId, idx: 0 });
      ctx.bus.emit("render:request", { dirty: true });
    }
  }

  handleCompositionUpdate(e: CompositionEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".se-ctx, .se-popover, .se-popup")) {
      return;
    }
    if (this.ctx.modalOpen()) {
      return;
    }
    if (!this.ctx.inputHost || !this.ctx.container.contains(this.ctx.inputHost)) {
      return;
    }
    this.ctx.state.composingText = e.data;
    this.ctx.state.isComposing = true;
    if (!this.ctx.state.flags.compositionRafId) {
      this.ctx.state.flags.compositionRafId = requestAnimationFrame(() => {
        this.ctx.state.flags.compositionRafId = 0;
        this.ctx.bus.emit("render:request", { dirty: true });
      });
    }
  }

  handleCompositionEnd(e: CompositionEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".se-ctx, .se-popover, .se-popup")) {
      return;
    }
    this.ctx.state.isComposing = false;
    if (this.ctx.modalOpen()) {
      this.ctx.state.composingText = "";
      this.resetHostCaret();
      return;
    }
    if (this.ctx.readOnly || !e.data) {
      this.ctx.state.composingText = "";
      if (this.ctx.readOnly) {
        if (this.ctx.inputHost) {
          this.ctx.inputHost.textContent = "";
        }
      } else {
        this.resetHostCaret();
      }
      return;
    }
    this.commitTextInsert(e.data, true);
  }

  handleBeforeInput(e: InputEvent): void {
    if (this.ctx.readOnly) {
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".se-ctx, .se-popover, .se-popup")) {
      return;
    }
    if (this.ctx.modalOpen()) {
      e.preventDefault();
      return;
    }
    if (
      e.isComposing ||
      e.inputType === "insertCompositionText" ||
      e.inputType === "insertFromComposition"
    ) {
      return;
    }
    if (e.inputType === "insertText" && e.data) {
      e.preventDefault();
      this.commitTextInsert(e.data);
    }
  }

  private isTypingSeparator(ch: string): boolean {
    return !!ch && TYPING_SEPARATOR_RE.test(ch);
  }

  private typingMergeKey(text: string, fromComposition: boolean): string {
    if (fromComposition) {
      this.typingRunId += 1;
      this.lastTypingText = text;
      return `typing:${this.typingRunId}`;
    }
    const first = Array.from(text)[0] ?? "";
    const prevLast = Array.from(this.lastTypingText).pop() ?? "";
    const startsNewWord =
      first !== "" && this.isTypingSeparator(prevLast) && !this.isTypingSeparator(first);
    if (this.lastTypingText === "" || startsNewWord) {
      this.typingRunId += 1;
    }
    this.lastTypingText = text;
    return `typing:${this.typingRunId}`;
  }

  /**
   * Insert plain text (typed characters, an IME result, or the input-event
   * fallback) at the current caret — replacing any active selection — then
   * move the caret past it and repaint.  Single mutation path shared by
   * beforeinput, the input fallback and compositionend.
   */
  commitTextInsert(text: string, fromComposition = false): void {
    const { ctx } = this;
    const codePoints = Array.from(text).length;
    const spans = ctx.state.spans && ctx.state.spans.length > 0 ? ctx.state.spans : null;
    let next: SSMLModel;
    let cursor: Cursor;
    if (spans) {
      const anchorRaw: Cursor = { blockId: spans[0].blockId, idx: spans[0].start };
      next = removeSpansFromModel(ctx.state.model, spans);
      const anchor = sanitizeCursor(next, anchorRaw) ?? anchorRaw;
      next = insertTextAtCursor(next, anchor, text);
      cursor = { blockId: anchor.blockId, idx: anchor.idx + codePoints };
      this.lastTypingText = "";
    } else {
      const c = ctx.state.cursor;
      let target = c ? sanitizeCursor(ctx.state.model, c) : null;
      if (!target && ctx.state.model.blocks.length > 0) {
        const last = ctx.state.model.blocks[ctx.state.model.blocks.length - 1];
        target = { blockId: last.id, idx: blockLen(last) };
      }
      if (target) {
        next = insertTextAtCursor(ctx.state.model, target, text);
        cursor = { ...target, idx: target.idx + codePoints };
      } else {
        const block: SSMLBlock = { id: createBlockId(), text };
        next = { blocks: [block], annotations: [], hints: [] };
        cursor = { blockId: block.id, idx: codePoints };
      }
    }
    ctx.bus.emit("cursor:change", cursor);
    ctx.state.composingText = "";
    ctx.state.isComposing = false;
    if (spans) {
      ctx.history.commit(next);
    } else {
      ctx.history.commit(next, true, this.typingMergeKey(text, fromComposition));
    }
    ctx.bus.emit("overlay:close");
    ctx.bus.emit("selection:change", null);
    this.resetHostCaret();
  }

  /**
   * Empty the hidden IME host and collapse the native selection to a caret INSIDE it.
   */
  resetHostCaret(): void {
    const host = this.ctx.inputHost;
    if (!host || this.ctx.readOnly) {
      return;
    }
    if (host.textContent) {
      host.textContent = "";
    }
    const sel = window.getSelection();
    if (!sel) {
      return;
    }
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(host, 0);
    range.collapse(true);
    sel.addRange(range);
  }

  scheduleCaretRender(): void {
    if (this.ctx.state.flags.caretRafId) {
      cancelAnimationFrame(this.ctx.state.flags.caretRafId);
    }
    this.ctx.state.flags.caretRafId = requestAnimationFrame(() => {
      this.ctx.state.flags.caretRafId = 0;
      if (this.tryMoveCaretInDom()) {
        return;
      }
      this.ctx.bus.emit("render:request", { dirty: true });
    });
  }

  /**
   * Without rebuilding the tree, relocate the .se-caret span to the current
   * logical cursor (or drop stale .se-sel highlights from a finished drag).
   * Returns true when the DOM caret is now correct, false when a full render
   * is required.  Only valid while contentDirty is false — the DOM then
   * still matches the last render, so repositioning is enough.
   */
  tryMoveCaretInDom(): boolean {
    const { ctx } = this;
    if (ctx.state.render.contentDirty || ctx.state.composingText) {
      return false;
    }
    const sel = window.getSelection();
    const collapsedSel =
      !!sel && sel.rangeCount > 0 && sel.isCollapsed && ctx.container.contains(sel.anchorNode);
    if (!collapsedSel) {
      return false;
    }
    if (ctx.readOnly) {
      return false;
    }
    const c = ctx.state.cursor;
    if (!c) {
      return false;
    }
    const blockEl = ctx.state.render.paintedEls?.get(c.blockId) ?? null;
    const vnodes = ctx.state.render.paintedVNodes?.get(c.blockId);
    if (!blockEl || !vnodes) {
      return false;
    }
    const ip = caretInsertionPoint(vnodes, c.idx);
    if (!ip) {
      return false;
    }
    let refs = ctx.state.render.paintedDomRefs?.get(c.blockId);
    if (!refs) {
      refs = buildBlockDomRefs(vnodes, blockEl);
      ctx.state.render.paintedDomRefs?.set(c.blockId, refs);
    }
    const parentEl = ip.group ? refs.get(ip.group) : blockEl;
    if (!parentEl || !blockEl.contains(parentEl)) {
      return false;
    }
    let refNode: Node | null = null;
    for (let i = ip.index; i < ip.list.length; i++) {
      const v = ip.list[i];
      if (v.type === "caret" || v.type === "composing") {
        continue;
      }
      const el = refs.get(v);
      if (!el || !el.isConnected || el.parentElement !== parentEl) {
        return false;
      }
      refNode = el;
      break;
    }
    ctx.selection.removeLiveHighlight();
    ctx.content.querySelectorAll(".se-caret").forEach((el) => el.remove());
    parentEl.insertBefore(createCaretSpan(), refNode);
    ctx.selection.positionInputHostToCursor();
    return true;
  }

  cancelCaretRender(): void {
    if (this.ctx.state.flags.caretRafId) {
      cancelAnimationFrame(this.ctx.state.flags.caretRafId);
      this.ctx.state.flags.caretRafId = 0;
    }
  }

  /** mousemove handler: when a press that looked like the second press of a
   *  double click starts to move, it is actually a drag — clear the flag so
   *  the browser's native drag-selection takes over. */
  onPointerMove(): void {
    if (this.ctx.state.flags.doubleClickPending) {
      this.ctx.state.flags.doubleClickPending = false;
    }
  }

  /**
   * mouseup handler: reconcile the native selection with the editor model
   * once a click / drag gesture has finished.  The native ::selection
   * background is transparent, so a finished drag is repainted as .se-sel
   * highlights, while a click collapses the selection into the hidden IME
   * host (focused with a real caret range) so the next keystroke / IME
   * composition has an editable target.
   */
  onPointerUp(e?: MouseEvent): void {
    const { ctx } = this;
    if (!ctx.state.flags.pointerDown) {
      return;
    }
    ctx.state.flags.pointerDown = false;
    ctx.state.flags.rightClickPending = false;
    if (ctx.state.flags.doubleClickPending) {
      return;
    }
    const sel = window.getSelection();

    if (ctx.readOnly) {
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (ctx.container.contains(range.commonAncestorContainer)) {
          const spans = getSelectionSpans(ctx.container);
          ctx.bus.emit("selection:change", spans);
          ctx.bus.emit("cursor:change", null);
          return;
        }
      }
      if (ctx.state.spans) {
        ctx.bus.emit("selection:change", null);
      }
      return;
    }

    if (!sel || sel.rangeCount === 0) {
      if (ctx.state.spans) {
        ctx.bus.emit("selection:change", null);
      }
      return;
    }
    const range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer;
    const local = ctx.container.contains(anc);
    const inHost = !!ctx.inputHost?.contains(anc);

    if (!local) {
      if (ctx.state.spans) {
        ctx.bus.emit("selection:change", null);
      }
      return;
    }

    if (sel.isCollapsed && !inHost) {
      ctx.selection.syncSelection();
      ctx.selection.focusInputHost();
      this.resetHostCaret();
    } else if (!sel.isCollapsed) {
      let spans = getSelectionSpans(ctx.container);
      if (spans && e) {
        spans = this.snapDragBoundary(spans, e);
      }
      ctx.bus.emit("selection:change", spans);
      if (spans) {
        ctx.bus.emit("cursor:change", null);
      }
      ctx.selection.focusInputHost();
      this.resetHostCaret();
    }
    this.scheduleCaretRender();
  }

  /**
   * Snap the final partially-covered character into a finished drag selection.
   */
  private snapDragBoundary(spans: SelectionSpan[], e: MouseEvent): SelectionSpan[] {
    const { ctx } = this;
    const first = spans[0];
    const last = spans[spans.length - 1];
    const forward = { blockId: last.blockId, idx: last.end };
    const backward = { blockId: first.blockId, idx: first.start - 1 };

    const wideAt = (blockId: string, idx: number): boolean => {
      if (idx < 0) {
        return false;
      }
      const block = ctx.state.model.blocks.find((b) => b.id === blockId);
      const ch = block ? Array.from(block.text)[idx] ?? "" : "";
      return /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch);
    };
    const charEl = (blockId: string, idx: number): HTMLElement | null => {
      const blockEl = ctx.content.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(blockId)}"]`,
      );
      if (!blockEl || idx < 0) {
        return null;
      }
      return blockEl.querySelector<HTMLElement>(`[data-char-idx="${idx}"]`);
    };
    const hit = (el: HTMLElement | null): -1 | 0 | 1 => {
      if (!el) {
        return 0;
      }
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX >= r.right) {
        return 0;
      }
      return e.clientX >= r.left + r.width * 0.35 ? 1 : -1;
    };
    if (wideAt(forward.blockId, forward.idx) && hit(charEl(forward.blockId, forward.idx)) === 1) {
      const next = spans.map((s) => ({ ...s }));
      next[next.length - 1].end += 1;
      return next;
    }
    if (
      wideAt(backward.blockId, backward.idx) &&
      hit(charEl(backward.blockId, backward.idx)) === 1
    ) {
      const next = spans.map((s) => ({ ...s }));
      next[0].start -= 1;
      return next;
    }
    return spans;
  }

  /**
   * A press inside the editor never reached a mouseup here — the button was
   * released outside the window, over another element, or over another
   * editor instance.  Clear the stuck press flag and reconcile the model
   * highlight with whatever native selection actually remains (the browser
   * may not have delivered the final selectionchange either).
   */
  finalizePointerGesture(): void {
    const { ctx } = this;
    if (!ctx.state.flags.pointerDown) {
      return;
    }
    ctx.state.flags.pointerDown = false;
    ctx.state.flags.doubleClickPending = false;
    ctx.state.flags.rightClickPending = false;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (ctx.container.contains(range.commonAncestorContainer)) {
        const spans = getSelectionSpans(ctx.container);
        ctx.bus.emit("selection:change", spans);
        ctx.bus.emit("cursor:change", null);
        return;
      }
    }
    if (ctx.state.spans) {
      ctx.bus.emit("selection:change", null);
    }
  }

  /**
   * document-level capture listener: a new press that starts OUTSIDE this
   * editor while a gesture is still flagged pending means the old gesture
   * was abandoned (its button was released elsewhere) — drop its state
   * before the fresh interaction proceeds.  Presses inside the container
   * are ignored: the container mousedown handler below owns those.
   */
  abandonIfExternalPress(e: MouseEvent): void {
    if (!this.ctx.state.flags.pointerDown) {
      return;
    }
    if (e.button !== 0 && e.button !== 2) {
      return;
    }
    const target = e.target as Node | null;
    if (target && this.ctx.container.contains(target)) {
      return;
    }
    this.finalizePointerGesture();
  }
}
