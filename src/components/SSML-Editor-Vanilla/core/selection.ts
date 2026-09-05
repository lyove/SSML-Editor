/**
 * SelectionService — native selection ⇄ virtual caret mapping.
 */
import type { EditorContext } from "./context";
import type { Cursor } from "../types";
import { blockLen, uid } from "../model/model";
import { getSelectionSpans, spansEqual } from "../utils/selection";
import { isEmptyModel } from "../utils/serialize";

export class SelectionService {
  constructor(private ctx: EditorContext) {}

  private hostPosRafId = 0;

  /**
   * rAF-throttled variant of `positionInputHostToCursor` for global
   * scroll/resize listeners: each captured event schedules at most one
   * layout pass per frame instead of querying rects on every scroll event.
   */
  scheduleInputHostPosition(): void {
    if (this.hostPosRafId) {
      return;
    }
    this.hostPosRafId = requestAnimationFrame(() => {
      this.hostPosRafId = 0;
      this.positionInputHostToCursor();
    });
  }

  cancelScheduledHostPosition(): void {
    if (this.hostPosRafId) {
      cancelAnimationFrame(this.hostPosRafId);
      this.hostPosRafId = 0;
    }
  }

  positionInputHostToCursor(): void {
    const { ctx } = this;
    const host = ctx.inputHost;
    if (!host) {
      return;
    }
    const caret = ctx.container.querySelector<HTMLElement>(".se-caret");
    const comp = caret ? null : ctx.container.querySelector<HTMLElement>(".se-composing");
    let rect: DOMRect | null = null;
    if (caret) {
      rect = caret.getBoundingClientRect();
    } else if (comp) {
      const r = comp.getBoundingClientRect();
      rect = new DOMRect(r.right, r.top, 0, r.height);
    } else {
      const c = ctx.state.cursor;
      if (c) {
        const blockEl = ctx.container.querySelector<HTMLElement>(
          `[data-block-id="${CSS.escape(c.blockId)}"]`,
        );
        if (blockEl) {
          const charEls = Array.from(blockEl.querySelectorAll<HTMLElement>("[data-char-idx]"));
          const target =
            charEls.find((e) => Number(e.dataset.charIdx) === c.idx) ??
            charEls[charEls.length - 1] ??
            null;
          if (target) {
            const r = target.getBoundingClientRect();
            const after = c.idx !== 0;
            rect = new DOMRect(after ? r.right : r.left, r.top, 0, r.height);
          }
        }
      }
    }
    if (!rect) {
      host.style.left = "-9999px";
      host.style.top = "-9999px";
      return;
    }
    const containingBlock = this.findContainingBlock();
    const cbRect = containingBlock.getBoundingClientRect();
    host.style.left = `${Math.round(rect.left - cbRect.left)}px`;
    host.style.top = `${Math.round(rect.top - cbRect.top)}px`;
  }

  /**
   * Find the real containing block for the hidden input host.
   */
  private findContainingBlock(): HTMLElement {
    const host = this.ctx.inputHost;
    if (!host) {
      return document.documentElement as HTMLElement;
    }
    let el: HTMLElement | null = host.parentElement;
    let positionedFallback: HTMLElement | null = null;
    while (el) {
      const cs = window.getComputedStyle(el);
      const contain = cs.contain || "";
      if (
        contain.includes("layout") ||
        contain.includes("paint") ||
        contain.includes("strict") ||
        contain.includes("content")
      ) {
        return el;
      }
      const transform = cs.transform;
      const perspective = cs.perspective;
      const filter = cs.filter;
      const willChange = cs.willChange || "";
      if (
        (transform && transform !== "none") ||
        (perspective && perspective !== "none") ||
        (filter && filter !== "none") ||
        willChange.includes("transform") ||
        willChange.includes("perspective") ||
        willChange.includes("filter")
      ) {
        return el;
      }
      if (cs.position !== "static" && !positionedFallback) {
        positionedFallback = el;
      }
      el = el.parentElement;
    }
    return positionedFallback ?? (document.documentElement as HTMLElement);
  }

  focusInputHost(): void {
    if (!this.ctx.inputHost) {
      return;
    }
    this.positionInputHostToCursor();
    if (document.activeElement !== this.ctx.inputHost) {
      this.ctx.inputHost.focus();
    }
  }

  selectionBelongsHere(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return false;
    }
    const range = sel.getRangeAt(0);
    return this.ctx.container.contains(range.commonAncestorContainer);
  }

  clearLocalSelection(): void {
    const { ctx } = this;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return;
    }
    const range = sel.getRangeAt(0);
    if (!ctx.container.contains(range.commonAncestorContainer)) {
      return;
    }
    if (ctx.inputHost?.contains(range.commonAncestorContainer)) {
      return;
    }
    if (ctx.state.flags.pointerDown) {
      return;
    }
    sel.removeAllRanges();
  }

  commitCursor(c: Cursor | null): void {
    this.ctx.state.cursor = c;
  }

  syncSelection(): void {
    const { ctx } = this;
    const sel = window.getSelection();
    const hasSelRange = !!sel && sel.rangeCount > 0;
    const localSel = hasSelRange
      ? ctx.container.contains(sel!.getRangeAt(0).commonAncestorContainer)
      : false;

    if (ctx.state.overlays.ctxMenuOpen && (!sel || sel.isCollapsed || !hasSelRange)) {
      if (localSel) {
        return;
      }
    }

    if (!hasSelRange) {
      return;
    }

    if (!localSel) {
      return;
    }

    if (sel!.isCollapsed) {
      const range = sel!.getRangeAt(0);
      const anc: Node = range.commonAncestorContainer;
      const ancEl = anc.nodeType === Node.TEXT_NODE ? anc.parentElement : (anc as Element);
      if (ancEl?.closest(".se-input-host")) {
        return;
      }
      if (ctx.state.flags.rightClickPending) {
        return;
      }

      ctx.bus.emit("overlay:close");
      ctx.bus.emit("selection:change", null);
      if (ctx.readOnly) {
        return;
      }
      const node = range.startContainer;
      if (ctx.container.contains(anc)) {
        const pos = this.resolveCaretFromRange(node, range.startOffset);
        if (pos) {
          ctx.bus.emit("cursor:change", pos);
        } else {
          this.commitCursorToEdge(node);
        }
      }
      return;
    }

    if (ctx.state.flags.doubleClickPending) {
      return;
    }
    const result = getSelectionSpans(ctx.container);
    if (!result) {
      ctx.bus.emit("overlay:close");
      ctx.bus.emit("selection:change", null);
      return;
    }
    ctx.bus.emit("selection:change", result);
    ctx.bus.emit("cursor:change", null);
    ctx.state.selRect = sel!.getRangeAt(0).getBoundingClientRect();
    if (ctx.state.flags.pointerDown) {
      ctx.ime.cancelCaretRender();
    }
  }

  applyLiveHighlight(): void {
    const { ctx } = this;
    const next = ctx.state.spans;
    const prev = ctx.state.render.lastSelSpans ?? [];
    const changed = !spansEqual(prev, next);
    ctx.state.render.lastSelSpans = next ? next.map((s) => ({ ...s })) : null;
    if (!changed || (!next && prev.length === 0)) {
      return;
    }

    const blockIds = new Set<string>();
    for (const s of prev) {
      blockIds.add(s.blockId);
    }
    if (next) {
      for (const s of next) {
        blockIds.add(s.blockId);
      }
    }

    for (const id of blockIds) {
      const blockEl = ctx.container.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(id)}"]`,
      );
      if (!blockEl) {
        continue;
      }
      const oldR = prev.filter((s) => s.blockId === id);
      const newR = next?.filter((s) => s.blockId === id) ?? [];
      const chars = blockEl.querySelectorAll<HTMLElement>("[data-char-idx]");
      for (const ch of chars) {
        const idx = Number(ch.getAttribute("data-char-idx"));
        const was = oldR.some((s) => idx >= s.start && idx < s.end);
        const is = newR.some((s) => idx >= s.start && idx < s.end);
        if (is && !was) {
          ch.classList.add("se-sel");
        } else if (was && !is) {
          ch.classList.remove("se-sel");
        }
      }
      if (newR.length > 0) {
        blockEl.querySelectorAll(".se-caret").forEach((el) => el.remove());
      }
    }
  }

  removeLiveHighlight(): void {
    const { ctx } = this;
    ctx.state.render.lastSelSpans = null;
    ctx.container.querySelectorAll(".se-ch.se-sel").forEach((el) => el.classList.remove("se-sel"));
  }

  applyBracketHoverRange(blockId: string, start: number, end: number, type: string): void {
    const blockEl = this.ctx.container.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(blockId)}"]`,
    );
    if (!blockEl) {
      return;
    }
    const chars = blockEl.querySelectorAll<HTMLElement>("[data-char-idx]");
    for (const ch of chars) {
      const idx = Number(ch.getAttribute("data-char-idx"));
      if (idx >= start && idx < end) {
        ch.classList.add("se-ch--bracket-hover");
        ch.setAttribute("data-hover-type", type);
      }
    }
  }

  removeBracketHoverRange(blockId: string): void {
    const blockEl = this.ctx.container.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(blockId)}"]`,
    );
    if (!blockEl) {
      return;
    }
    blockEl.querySelectorAll<HTMLElement>("[data-char-idx].se-ch--bracket-hover").forEach((ch) => {
      ch.classList.remove("se-ch--bracket-hover");
      ch.removeAttribute("data-hover-type");
    });
  }

  resolveCaretFromRange(node: Node, offset: number): Cursor | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement as Element;
      const el = parent?.closest<HTMLElement>("[data-char-idx]") ?? null;
      if (el) {
        const blockEl = el.closest<HTMLElement>("[data-block-id]");
        if (blockEl) {
          const after = parent === el && offset > 0;
          return {
            blockId: blockEl.getAttribute("data-block-id") ?? "",
            idx: Number(el.getAttribute("data-char-idx")) + (after ? 1 : 0),
          };
        }
      }
      return null;
    }

    const el = node as HTMLElement;
    if (el.hasAttribute?.("data-char-idx")) {
      const blockEl = el.closest<HTMLElement>("[data-block-id]");
      if (blockEl) {
        return {
          blockId: blockEl.getAttribute("data-block-id") ?? "",
          idx: Number(el.getAttribute("data-char-idx")) + (offset > 0 ? 1 : 0),
        };
      }
    }
    const breakEl = el.closest?.<HTMLElement>(".se-break[data-pos]");
    if (breakEl) {
      const blockEl = breakEl.closest<HTMLElement>("[data-block-id]");
      if (blockEl) {
        return {
          blockId: blockEl.getAttribute("data-block-id") ?? "",
          idx: Number(breakEl.getAttribute("data-pos")),
        };
      }
    }
    const bracketEl = el.closest?.<HTMLElement>(".se-bracket[data-ann-id]");
    if (bracketEl) {
      const blockEl = bracketEl.closest<HTMLElement>("[data-block-id]");
      if (blockEl) {
        const right = bracketEl.getAttribute("data-side") === "right";
        const idx = Number(bracketEl.getAttribute(right ? "data-ann-end" : "data-ann-start"));
        return { blockId: blockEl.getAttribute("data-block-id") ?? "", idx };
      }
    }
    if (el.nodeType === Node.ELEMENT_NODE && el.childNodes) {
      const firstCharAfter = (from: number): HTMLElement | null => {
        const children = el.childNodes;
        for (let i = from; i < children.length; i++) {
          const child = children[i];
          if (child.nodeType !== Node.ELEMENT_NODE) {
            continue;
          }
          const c = child as HTMLElement;
          if (c.hasAttribute("data-char-idx")) {
            return c;
          }
          const inner = c.querySelector<HTMLElement>("[data-char-idx]");
          if (inner) {
            return inner;
          }
        }
        return null;
      };
      const lastCharBefore = (from: number): HTMLElement | null => {
        const children = el.childNodes;
        for (let i = Math.min(from, children.length) - 1; i >= 0; i--) {
          const child = children[i];
          if (child.nodeType !== Node.ELEMENT_NODE) {
            continue;
          }
          const c = child as HTMLElement;
          if (c.hasAttribute("data-char-idx")) {
            return c;
          }
          const inner = c.querySelectorAll<HTMLElement>("[data-char-idx]");
          if (inner.length > 0) {
            return inner[inner.length - 1];
          }
        }
        return null;
      };
      const cursorFromChar = (c: HTMLElement, adjust: 0 | 1): Cursor | null => {
        const b = c.closest<HTMLElement>("[data-block-id]");
        if (!b) {
          return null;
        }
        return {
          blockId: b.getAttribute("data-block-id") ?? "",
          idx: Number(c.getAttribute("data-char-idx")) + adjust,
        };
      };
      const after = firstCharAfter(Math.min(offset, el.childNodes.length));
      if (after) {
        const cur = cursorFromChar(after, 0);
        if (cur) {
          return cur;
        }
      }
      const before = lastCharBefore(offset);
      if (before) {
        const cur = cursorFromChar(before, 1);
        if (cur) {
          return cur;
        }
      }
    }
    return null;
  }

  caretRangeFromPoint(x: number, y: number): Range | null {
    const model = this.ctx.container.ownerDocument;
    if (typeof model.caretRangeFromPoint === "function") {
      return model.caretRangeFromPoint(x, y);
    }
    const pos = (
      model as unknown as {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
      }
    ).caretPositionFromPoint?.(x, y);
    if (pos) {
      const r = model.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  normalizeRangeAnchor(range: Range): void {
    const node = range.startContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el = node as Element;
    if (!el.hasAttribute?.("data-char-idx")) {
      return;
    }
    const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
    if (textNodes.length === 0) {
      return;
    }
    const after = range.startOffset > 0;
    const tn = after ? textNodes[textNodes.length - 1] : textNodes[0];
    range.setStart(tn, after ? tn.textContent?.length ?? 0 : 0);
    range.collapse(true);
  }

  placeCaretFromPoint(x: number, y: number): void {
    const { ctx } = this;
    if (isEmptyModel(ctx.state.model)) {
      const blockId = uid();
      ctx.state.model = {
        ...ctx.state.model,
        blocks: [{ id: blockId, text: "" }],
      };
      ctx.bus.emit("cursor:change", { blockId, idx: 0 });
      ctx.state.flags.pointerDown = true;
      ctx.ime.cancelCaretRender();
      ctx.bus.emit("render:request", { dirty: true });
      return;
    }
    const range = this.caretRangeFromPoint(x, y);
    if (!range || !ctx.container.contains(range.commonAncestorContainer)) {
      return;
    }
    this.normalizeRangeAnchor(range);
    const cursor = this.resolveCaretFromRange(range.startContainer, range.startOffset);
    if (!cursor) {
      return;
    }
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.commitCursor(cursor);
    ctx.state.flags.pointerDown = true;
    ctx.ime.cancelCaretRender();
  }

  commitCursorToEdge(node: Node): void {
    const { ctx } = this;
    const host =
      (node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      )?.closest<HTMLElement>("[data-block-id]") ?? null;
    const target = host ?? ctx.container.querySelector<HTMLElement>("[data-block-id]:last-of-type");
    if (target) {
      const block = ctx.state.model.blocks.find(
        (b) => b.id === target.getAttribute("data-block-id"),
      );
      this.commitCursor({
        blockId: target.getAttribute("data-block-id") ?? "",
        idx: block ? blockLen(block) : 0,
      });
    }
  }
}
