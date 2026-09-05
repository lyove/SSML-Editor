/**
 * RenderService — render pipeline: floating layer, popover sync and block-tree rebuild.
 */
import type { EditorContext } from "./context";
import { isEmptyModel } from "../utils/serialize";
import { spansEqual } from "../utils/selection";
import {
  buildBlockDomRefs,
  type BlockRenderCtx,
  buildBlockVNodes,
  diffBlockChildren,
  materializeVNodes,
  type VNode,
  type VNodeDomRefs,
} from "../view/block-render";
import {
  buildBracketTooltip,
  buildCrossBoundaryDialog,
  buildHintTooltip,
  buildOverlapDialog,
} from "../view/overlays";
import {
  BreakPopover,
  ProsodyPopover,
  SayAsPopover,
  EmphasisPopover,
  HintPopover,
  PhonemePopover,
} from "../components";
import type { ModelHint, SSMLAnnotation, SSMLModel } from "../types";

const IDLE_PAINT_MIN_BLOCKS = 2000;
const IDLE_PAINT_CHUNK = 400;
const IDLE_PAINT_BUDGET_MS = 10;
const IDLE_PAINT_TIMEOUT_MS = 30;

function scheduleIdle(task: () => void, timeoutMs: number): () => void {
  let cancelled = false;
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(
      () => {
        if (!cancelled) {
          task();
        }
      },
      { timeout: timeoutMs },
    );
    return () => {
      cancelled = true;
      cancelIdleCallback(id);
    };
  }
  const id = window.setTimeout(() => {
    if (!cancelled) {
      task();
    }
  }, 0);
  return () => {
    cancelled = true;
    window.clearTimeout(id);
  };
}

function annKeyOf(a: SSMLAnnotation): string {
  const attrs = Object.keys(a.attrs)
    .sort()
    .map((k) => `${k}=${a.attrs[k]}`)
    .join(",");
  return `${a.id}|${a.type}|${a.start}|${a.end}|${attrs}`;
}

function hintKeyOf(h: ModelHint): string {
  return `${h.id}|${h.start}|${h.end}|${h.text}`;
}

/**
 * Walk a block's VNode tree (including hint-group children) and return true
 * when at least one char carries phoneme display data — either an explicit
 * phoneme annotation or a showAll auto-generated reading.
 */
function vnodesHavePinyin(vnodes: VNode[]): boolean {
  for (const vn of vnodes) {
    if (vn.type === "char" && vn.phoneme) {
      return true;
    }
    if (vn.type === "hint-group" && vnodesHavePinyin(vn.children)) {
      return true;
    }
  }
  return false;
}

export class RenderService {
  constructor(private ctx: EditorContext) {}

  /**
   * Cached annotation/hint grouping maps.
   */
  private annMapCache: {
    anns: SSMLAnnotation[];
    hints: ModelHint[];
    annsByBlock: Map<string, SSMLAnnotation[]>;
    hintsByBlock: Map<string, ModelHint[]>;
  } | null = null;

  private floatSignature = "";

  ensureFloatLayer(): HTMLDivElement {
    if (!this.ctx.state.render.floatLayer) {
      const fl = document.createElement("div");
      fl.className = "se-float-layer";
      this.ctx.container.appendChild(fl);
      this.ctx.state.render.floatLayer = fl;
    }
    return this.ctx.state.render.floatLayer;
  }

  render(): void {
    this.syncPopovers();
    if (this.ctx.state.render.contentDirty && !this.ctx.state.render.paintingChunks) {
      this.renderBlocks();
      this.ctx.state.render.contentDirty = false;
      this.ctx.state.flags.hostPosStale = true;
    }
    this.syncPlaceholder();
    this.renderFloating();
    if (this.ctx.state.flags.hostPosStale) {
      this.ctx.selection.positionInputHostToCursor();
      this.ctx.state.flags.hostPosStale = false;
    }
  }

  /**
   * Show or hide the placeholder
   */
  private syncPlaceholder(): void {
    const { ctx } = this;
    const shouldShow =
      !!ctx.placeholder &&
      isEmptyModel(ctx.state.model) &&
      !ctx.state.composingText &&
      !ctx.state.isComposing;
    const existing = ctx.content.querySelector<HTMLElement>(".se-placeholder");
    if (shouldShow && !existing) {
      const ph = document.createElement("div");
      ph.className = "se-placeholder";
      ph.textContent = ctx.placeholder;
      ctx.content.appendChild(ph);
    } else if (!shouldShow && existing) {
      existing.remove();
    }
  }

  markContentDirty(): void {
    this.ctx.state.render.contentDirty = true;
  }

  syncPopovers(): void {
    const { ctx } = this;
    if (ctx.state.flags.popoverSyncGuard) {
      return;
    }
    ctx.state.flags.popoverSyncGuard = true;
    try {
      // Editing (phoneme)
      if (ctx.state.overlays.editing && !ctx.state.overlays.editingPopover) {
        ctx.state.overlays.editingPopover = new PhonemePopover({
          rect: ctx.state.overlays.editing.rect,
          chars: ctx.state.overlays.editing.chars,
          onCharChange: (pos, val, tone) => ctx.actions.writePhoneme(pos, val, tone),
          onCharRemove: (pos) => ctx.actions.writePhoneme(pos, "", ""),
          onClose: (e?: Event) => ctx.actions.closeEditing(e),
        });
      } else if (!ctx.state.overlays.editing && ctx.state.overlays.editingPopover) {
        ctx.state.overlays.editingPopover.destroy();
        ctx.state.overlays.editingPopover = null;
      }

      // Annotation target popover
      if (ctx.state.overlays.annTarget && !ctx.state.overlays.annPopover) {
        const t = ctx.state.overlays.annTarget;
        const common = {
          rect: t.rect,
          initial: t.existing?.attrs ?? null,
          onConfirm: (attrs: Record<string, string>) => ctx.actions.handleAnnConfirm(attrs),
          onRemove: t.existing ? () => ctx.actions.handleAnnRemove() : undefined,
          onClose: (e?: Event) => ctx.actions.closeAnnTarget(e),
        };
        if (t.type === "break") {
          ctx.state.overlays.annPopover = new BreakPopover(common);
        } else if (t.type === "prosody") {
          ctx.state.overlays.annPopover = new ProsodyPopover(common);
        } else if (t.type === "sayAs") {
          ctx.state.overlays.annPopover = new SayAsPopover(common);
        } else if (t.type === "emphasis") {
          ctx.state.overlays.annPopover = new EmphasisPopover(common);
        } else {
          ctx.state.overlays.annPopover = null;
        }
      } else if (!ctx.state.overlays.annTarget && ctx.state.overlays.annPopover) {
        ctx.state.overlays.annPopover.destroy();
        ctx.state.overlays.annPopover = null;
      }

      // Hint popover
      if (ctx.state.overlays.hintTarget && !ctx.state.overlays.hintPopover) {
        const h = ctx.state.overlays.hintTarget;
        ctx.state.overlays.hintPopover = new HintPopover({
          rect: h.rect,
          initialText: h.initialText,
          onConfirm: (text) => ctx.actions.handleHintConfirm(text),
          onRemove: h.initialText ? () => ctx.actions.handleHintRemove() : undefined,
          onClose: (e?: Event) => ctx.actions.closeHintTarget(e),
        });
      } else if (!ctx.state.overlays.hintTarget && ctx.state.overlays.hintPopover) {
        ctx.state.overlays.hintPopover.destroy();
        ctx.state.overlays.hintPopover = null;
      }
    } finally {
      ctx.state.flags.popoverSyncGuard = false;
    }
  }

  blockRenderCtx(): BlockRenderCtx {
    const model = this.ctx.state.model;
    const hints = model.hints;
    let maps = this.annMapCache;
    if (!maps || maps.anns !== model.annotations || maps.hints !== hints) {
      const annsByBlock = new Map<string, SSMLAnnotation[]>();
      for (const a of model.annotations) {
        let arr = annsByBlock.get(a.blockId);
        if (!arr) {
          arr = [];
          annsByBlock.set(a.blockId, arr);
        }
        arr.push(a);
      }
      const hintsByBlock = new Map<string, ModelHint[]>();
      for (const h of hints) {
        let arr = hintsByBlock.get(h.blockId);
        if (!arr) {
          arr = [];
          hintsByBlock.set(h.blockId, arr);
        }
        arr.push(h);
      }
      for (const arr of hintsByBlock.values()) {
        if (arr.length > 1) {
          arr.sort((a, b) => a.start - b.start);
        }
      }
      maps = { anns: model.annotations, hints, annsByBlock, hintsByBlock };
      this.annMapCache = maps;
    }
    return {
      model,
      spans: this.ctx.state.spans,
      cursor: this.ctx.state.cursor,
      composingText: this.ctx.state.composingText,
      readOnly: this.ctx.readOnly,
      hoveredPairId: this.ctx.state.overlays.hoveredPairId,
      Features: this.ctx.Features,
      annsByBlock: maps.annsByBlock,
      hintsByBlock: maps.hintsByBlock,
    };
  }

  /**
   * Build one stable string per block from the only inputs that affect a
   * block's VNode sequence: its text, its annotations and its hints.  This
   * single map replaces the previous text/ann/hint maps and is the sole
   * input used to decide which blocks need to be rebuilt.
   */
  private computeFingerprints(
    model: SSMLModel,
    annsByBlock: Map<string, SSMLAnnotation[]>,
    hintsByBlock: Map<string, ModelHint[]>,
  ): Map<string, string> {
    const out = new Map<string, string>();
    for (const block of model.blocks) {
      const anns = annsByBlock.get(block.id) ?? [];
      const hints = hintsByBlock.get(block.id) ?? [];
      const annKey = anns.map(annKeyOf).sort().join("\u0000");
      const hintKey = hints.map(hintKeyOf).sort().join("\u0000");
      out.set(block.id, `${block.text}\u0000${annKey}\u0000${hintKey}`);
    }
    return out;
  }

  renderBlocks(): void {
    const { ctx } = this;
    const model = ctx.state.model;
    const isEmpty = isEmptyModel(model);

    if (
      !ctx.state.render.paintedEls ||
      ctx.state.render.forceFullRender ||
      isEmpty !== ctx.state.render.paintedEmpty
    ) {
      this.paintAllLines();
      return;
    }

    const dirty = new Set<string>();
    const docChanged = ctx.state.render.paintedModel !== model;

    if (docChanged) {
      const renderCtx = this.blockRenderCtx();
      const fingerprints = this.computeFingerprints(
        model,
        renderCtx.annsByBlock,
        renderCtx.hintsByBlock,
      );
      const prev = ctx.state.render.paintedFingerprints;
      for (const block of model.blocks) {
        if ((prev?.get(block.id) ?? "") !== (fingerprints.get(block.id) ?? "")) {
          dirty.add(block.id);
        }
      }
      ctx.state.render.paintedFingerprints = fingerprints;
      ctx.state.render.paintedModel = model;
    }

    const caret = ctx.state.cursor;
    if (caret) {
      dirty.add(caret.blockId);
    }
    if (ctx.state.spans) {
      for (const s of ctx.state.spans) {
        dirty.add(s.blockId);
      }
    }
    if (
      ctx.state.render.lastSelSpans &&
      !spansEqual(ctx.state.render.lastSelSpans, ctx.state.spans)
    ) {
      for (const s of ctx.state.render.lastSelSpans) {
        dirty.add(s.blockId);
      }
    }

    if (!docChanged && dirty.size === 0) {
      if (!caret) {
        ctx.content.querySelectorAll(".se-caret").forEach((el) => el.remove());
        ctx.state.render.paintedCaretEl = null;
      }
      ctx.state.render.lastSelSpans = ctx.state.spans
        ? ctx.state.spans.map((s) => ({ ...s }))
        : null;
      return;
    }

    const els = ctx.state.render.paintedEls!;
    let structural = els.size !== model.blocks.length;
    if (!structural) {
      for (const id of dirty) {
        if (!els.has(id)) {
          structural = true;
          break;
        }
      }
    }
    if (structural) {
      this.reconcileLines(model, dirty);
    } else {
      this.rebuildDirtyLines(model, dirty);
    }

    if (!caret) {
      ctx.content.querySelectorAll(".se-caret").forEach((el) => el.remove());
      ctx.state.render.paintedCaretEl = null;
    } else {
      const oldCaret = ctx.state.render.paintedCaretEl;
      const blockEl = ctx.state.render.paintedEls!.get(caret.blockId) ?? null;
      if (oldCaret) {
        if (!oldCaret.isConnected) {
          ctx.state.render.paintedCaretEl = blockEl?.querySelector(".se-caret") ?? null;
        } else if (!blockEl || !blockEl.contains(oldCaret)) {
          oldCaret.remove();
          ctx.state.render.paintedCaretEl = blockEl?.querySelector(".se-caret") ?? null;
        }
      } else if (blockEl) {
        ctx.state.render.paintedCaretEl = blockEl.querySelector(".se-caret") ?? null;
      }
    }
    ctx.state.render.lastSelSpans = ctx.state.spans ? ctx.state.spans.map((s) => ({ ...s })) : null;
  }

  private paintAllLines(): void {
    const model = this.ctx.state.model;
    if (model.blocks.length >= IDLE_PAINT_MIN_BLOCKS) {
      this.beginChunkedPaint(model);
      return;
    }
    this.paintAllLinesSync(model);
  }

  private beginChunkedPaint(target: SSMLModel): void {
    const { ctx } = this;
    const epoch = ++ctx.state.render.paintEpoch;
    if (ctx.state.render.idlePaintCancel) {
      ctx.state.render.idlePaintCancel();
      ctx.state.render.idlePaintCancel = null;
    }
    ctx.state.render.paintingChunks = true;
    const staging = document.createDocumentFragment();
    const els = new Map<string, HTMLElement>();
    const vnodesMap = new Map<string, VNode[]>();
    const domRefs = new Map<string, VNodeDomRefs>();
    const renderCtx = this.blockRenderCtx();
    const blocks = target.blocks;
    let i = 0;

    const step = (): void => {
      if (epoch !== ctx.state.render.paintEpoch || !ctx.state.render.paintingChunks) {
        return;
      }
      if (ctx.state.model !== target) {
        ctx.state.render.paintingChunks = false;
        ctx.state.render.idlePaintCancel = null;
        ctx.state.render.contentDirty = true;
        this.render();
        return;
      }
      const frag = document.createDocumentFragment();
      const started = performance.now();
      let built = 0;
      while (i < blocks.length) {
        const block = blocks[i];
        const vns = buildBlockVNodes(renderCtx, block);
        const p = document.createElement("p");
        p.className = "se-line";
        if (vnodesHavePinyin(vns)) {
          p.classList.add("has-pinyin");
        }
        p.setAttribute("data-block-id", block.id);
        p.append(...materializeVNodes(vns));
        frag.appendChild(p);
        els.set(block.id, p);
        vnodesMap.set(block.id, vns);
        domRefs.set(block.id, buildBlockDomRefs(vns, p));
        i++;
        built++;
        if (built >= IDLE_PAINT_CHUNK) {
          break;
        }
        if ((built & 63) === 0 && performance.now() - started > IDLE_PAINT_BUDGET_MS) {
          break;
        }
      }
      if (frag.childNodes.length > 0) {
        staging.appendChild(frag);
      }

      if (i < blocks.length) {
        ctx.state.render.idlePaintCancel = scheduleIdle(step, IDLE_PAINT_TIMEOUT_MS);
        return;
      }

      ctx.content.replaceChildren(staging);
      ctx.state.render.paintingChunks = false;
      ctx.state.render.idlePaintCancel = null;
      ctx.state.render.paintedEls = els;
      ctx.state.render.paintedFingerprints = this.computeFingerprints(
        target,
        renderCtx.annsByBlock,
        renderCtx.hintsByBlock,
      );
      ctx.state.render.paintedVNodes = vnodesMap;
      ctx.state.render.paintedDomRefs = domRefs;
      ctx.state.render.paintedModel = target;
      ctx.state.render.paintedEmpty = false;
      ctx.state.render.forceFullRender = false;
      ctx.state.render.lastSelSpans = ctx.state.spans
        ? ctx.state.spans.map((s) => ({ ...s }))
        : null;
      ctx.state.render.paintedCaretEl = ctx.content.querySelector(".se-caret") ?? null;
      ctx.state.render.contentDirty = true;
      this.render();
    };

    ctx.state.render.idlePaintCancel = scheduleIdle(step, IDLE_PAINT_TIMEOUT_MS);
  }

  private paintAllLinesSync(model: SSMLModel): void {
    const { ctx } = this;
    const empty = isEmptyModel(model);
    const frag = document.createDocumentFragment();
    const els = new Map<string, HTMLElement>();
    const vnodesMap = new Map<string, VNode[]>();
    const domRefs = new Map<string, VNodeDomRefs>();
    const renderCtx = this.blockRenderCtx();
    const fingerprints = this.computeFingerprints(
      model,
      renderCtx.annsByBlock,
      renderCtx.hintsByBlock,
    );
    for (const block of model.blocks) {
      const vns = buildBlockVNodes(renderCtx, block);
      const p = document.createElement("p");
      p.className = "se-line";
      if (vnodesHavePinyin(vns)) {
        p.classList.add("has-pinyin");
      }
      p.setAttribute("data-block-id", block.id);
      p.append(...materializeVNodes(vns));
      frag.appendChild(p);
      els.set(block.id, p);
      vnodesMap.set(block.id, vns);
      domRefs.set(block.id, buildBlockDomRefs(vns, p));
    }
    ctx.content.replaceChildren(frag);
    ctx.state.render.paintedEls = els;
    ctx.state.render.paintedFingerprints = fingerprints;
    ctx.state.render.paintedVNodes = vnodesMap;
    ctx.state.render.paintedDomRefs = domRefs;
    ctx.state.render.paintedModel = model;
    ctx.state.render.paintedEmpty = empty;
    ctx.state.render.forceFullRender = false;
    ctx.state.render.lastSelSpans = ctx.state.spans ? ctx.state.spans.map((s) => ({ ...s })) : null;
    ctx.state.render.paintedCaretEl = ctx.content.querySelector(".se-caret") ?? null;
  }

  private rebuildDirtyLines(model: SSMLModel, dirty: Set<string>): void {
    if (dirty.size === 0) {
      return;
    }
    const { ctx } = this;
    const els = ctx.state.render.paintedEls!;
    const paintedVNs = ctx.state.render.paintedVNodes;
    const domRefs = ctx.state.render.paintedDomRefs;
    const renderCtx = this.blockRenderCtx();
    for (const block of model.blocks) {
      if (dirty.has(block.id)) {
        const el = els.get(block.id);
        if (el) {
          const prev = paintedVNs?.get(block.id);
          const next = buildBlockVNodes(renderCtx, block);
          el.classList.toggle("has-pinyin", vnodesHavePinyin(next));
          if (prev) {
            diffBlockChildren(prev, next, el);
          } else {
            el.replaceChildren(...materializeVNodes(next));
          }
          paintedVNs?.set(block.id, next);
          domRefs?.set(block.id, buildBlockDomRefs(next, el));
        }
      }
    }
  }

  private reconcileLines(model: SSMLModel, dirty: Set<string>): void {
    const { ctx } = this;
    const content = ctx.content;
    const live = new Set(model.blocks.map((b) => b.id));
    const els = ctx.state.render.paintedEls!;
    const paintedVNs = ctx.state.render.paintedVNodes;
    const domRefs = ctx.state.render.paintedDomRefs;
    for (const [id, el] of els) {
      if (!live.has(id)) {
        el.remove();
        els.delete(id);
        ctx.state.render.paintedFingerprints?.delete(id);
        paintedVNs?.delete(id);
        domRefs?.delete(id);
      }
    }

    const renderCtx = this.blockRenderCtx();
    let prev: HTMLElement | null = null;
    for (const block of model.blocks) {
      let el = els.get(block.id);
      if (!el) {
        el = document.createElement("p");
        el.className = "se-line";
        el.setAttribute("data-block-id", block.id);
        els.set(block.id, el);
        dirty.add(block.id);
      }
      const vns = dirty.has(block.id)
        ? buildBlockVNodes(renderCtx, block)
        : paintedVNs?.get(block.id) ?? [];
      el.classList.toggle("has-pinyin", vnodesHavePinyin(vns));
      if (dirty.has(block.id)) {
        const prevVNs = paintedVNs?.get(block.id);
        if (prevVNs) {
          diffBlockChildren(prevVNs, vns, el);
        } else {
          el.replaceChildren(...materializeVNodes(vns));
        }
        paintedVNs?.set(block.id, vns);
        domRefs?.set(block.id, buildBlockDomRefs(vns, el));
      }
      const atPos =
        el.parentElement === content &&
        (prev === null ? content.firstElementChild === el : prev.nextElementSibling === el);
      if (!atPos) {
        content.insertBefore(el, prev ? prev.nextElementSibling : content.firstElementChild);
      }
      prev = el;
    }
    for (const child of Array.from(content.children)) {
      if (
        child.classList.contains("se-line") &&
        !live.has((child as HTMLElement).getAttribute("data-block-id") ?? "")
      ) {
        child.remove();
      }
    }
  }

  private currentFloatSignature(): string {
    const o = this.ctx.state.overlays;
    const bracket = o.bracketTooltip;
    const hint = o.hoveredHint;
    const overlap = o.overlapPrompt;
    const cross = o.crossBoundaryPrompt;
    return [
      bracket ? `bracket:${bracket.ann.id}` : "",
      hint
        ? `hint:${hint.text}:${hint.el.getAttribute("data-block-id") ?? ""}:${hint.el.isConnected}`
        : "",
      overlap
        ? `overlap:${overlap.type}:${overlap.blockId}:${overlap.start}:${
            overlap.end
          }:${JSON.stringify(overlap.attrs)}:${overlap.conflicts.map((c) => c.id).join(",")}`
        : "",
      cross
        ? `cross:${cross.type}:${cross.start}:${cross.end}:${cross.existing
            .map((c) => c.id)
            .join(",")}`
        : "",
    ].join("|");
  }

  renderFloating(): void {
    const { ctx } = this;
    const signature = this.currentFloatSignature();
    if (signature === this.floatSignature && ctx.state.render.floatLayer) {
      return;
    }
    this.floatSignature = signature;
    const fl = this.ensureFloatLayer();
    fl.replaceChildren();

    if (ctx.state.overlays.bracketTooltip) {
      const { ann, rect } = ctx.state.overlays.bracketTooltip;
      const live = ctx.container.querySelector<HTMLElement>(
        `.se-break[data-ann-id="${CSS.escape(ann.id)}"], .se-bracket[data-ann-id="${CSS.escape(
          ann.id,
        )}"]`,
      );
      fl.appendChild(buildBracketTooltip(ann, live?.getBoundingClientRect() ?? rect));
    }

    if (ctx.state.overlays.hoveredHint) {
      let h = ctx.state.overlays.hoveredHint;
      if (!h.el.isConnected) {
        const blockId = h.el.getAttribute("data-block-id");
        const selector = blockId
          ? `.se-hint-group[data-block-id="${CSS.escape(blockId)}"][data-hint="${CSS.escape(
              h.text,
            )}"]`
          : `[data-hint="${CSS.escape(h.text)}"]`;
        const fresh = ctx.container.querySelector<HTMLElement>(selector);
        if (fresh) {
          h = { ...h, el: fresh };
          ctx.state.overlays.hoveredHint = h;
        }
      }
      if (h.el.isConnected) {
        fl.appendChild(buildHintTooltip(h));
      }
    }

    if (ctx.state.overlays.overlapPrompt) {
      fl.appendChild(
        buildOverlapDialog(ctx.state.overlays.overlapPrompt, {
          onCancel: () => ctx.actions.handleOverlapCancel(),
          onSplit: () => ctx.actions.handleOverlapSplit(),
          onReplace: () => ctx.actions.handleOverlapReplace(),
        }),
      );
    }

    if (ctx.state.overlays.crossBoundaryPrompt) {
      fl.appendChild(
        buildCrossBoundaryDialog(ctx.state.overlays.crossBoundaryPrompt, {
          onDismiss: () => ctx.actions.handleCrossBoundaryDismiss(),
        }),
      );
    }
  }
}
