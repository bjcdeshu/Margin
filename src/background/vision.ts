import {
  formatGlossaryListForPrompt,
  isGlossaryEntryApplicable,
  resolveGlossaryTarget,
  stripThinkingBlocks,
} from '@core/prompts';
import { getEnglishLanguageName } from '@shared/constants';
import type { GlossaryEntry, VisionBoxRegion } from '@shared/types';

export function buildVisionTranslationPrompts(params: {
  fromLang: string;
  toLang: string;
  glossary?: readonly GlossaryEntry[];
  pageUrl?: string;
}): { systemPrompt: string; userPrompt: string } {
  const { fromLang, toLang, glossary = [], pageUrl } = params;
  const toName = getEnglishLanguageName(toLang);
  const fromClause =
    !fromLang || fromLang === 'auto'
      ? 'any source language'
      : getEnglishLanguageName(fromLang);

  const applicableGlossary = glossary
    .filter((entry) => isGlossaryEntryApplicable(entry, pageUrl))
    .slice(0, 40)
    .map((entry) => ({
      entry,
      key: entry.k.trim(),
      target: resolveGlossaryTarget(entry),
      hasDomain: Boolean(entry.domain?.trim()),
    }));

  const glossaryFormatted = formatGlossaryListForPrompt(applicableGlossary);
  const glossaryLine = glossaryFormatted
    ? `\nRequired Glossary (preserve exact target terms): ${glossaryFormatted}`
    : '';

  const systemPrompt = [
    `You are an accurate visual document and comic/manga translator.`,
    `Detect every readable text block or speech bubble in the image (supporting both horizontal text and vertical Japanese/Chinese columns) and translate from ${fromClause} into ${toName}.`,
    `Respond ONLY with a valid JSON array using normalized 0..1000 coordinates [ymin, xmin, ymax, xmax]:`,
    `[{"box":[ymin,xmin,ymax,xmax],"src":"original text","trans":"translated text","vertical":false}]`,
    `If the image contains no readable text, return [].`,
  ].join(' ');

  const userPrompt = `Extract and translate all visible text regions into ${toName}.${glossaryLine}`;

  return { systemPrompt, userPrompt };
}

function clampCoord(val: number): number {
  return Math.max(0, Math.min(1000, Math.round(val)));
}

function normalizeBoxArray(
  rawBox: unknown,
): [number, number, number, number] | null {
  let coords: number[] | null = null;

  if (Array.isArray(rawBox) && rawBox.length === 4) {
    const nums = rawBox.map((v) =>
      typeof v === 'number' ? v : Number.parseFloat(String(v)),
    );
    if (nums.every((n) => Number.isFinite(n))) {
      coords = nums;
    }
  } else if (rawBox && typeof rawBox === 'object') {
    const obj = rawBox as Record<string, unknown>;
    const candidates = [
      obj.ymin ?? obj.y1 ?? obj.top,
      obj.xmin ?? obj.x1 ?? obj.left,
      obj.ymax ?? obj.y2 ?? obj.bottom,
      obj.xmax ?? obj.x2 ?? obj.right,
    ].map((v) => (typeof v === 'number' ? v : Number.parseFloat(String(v))));
    if (candidates.every((n) => Number.isFinite(n))) {
      coords = candidates;
    }
  }

  if (!coords) return null;

  // Rescue 0..1 float-normalized coordinates (e.g. `[0.12, 0.25, 0.34, 0.88]`)
  const allWithinUnit = coords.every((n) => n >= 0 && n <= 1);
  const hasFractional = coords.some((n) => n > 0 && n < 1 && !Number.isInteger(n));
  const scaled =
    allWithinUnit && (hasFractional || Math.max(...coords) <= 1 && Math.max(...coords) > 0 && coords.every((n) => n <= 1) && !coords.some((n) => n > 1))
      ? coords.every((n) => Number.isInteger(n)) && Math.max(...coords) === 1
        ? coords
        : coords.map((n) => n * 1000)
      : coords;

  let ymin = clampCoord(scaled[0]);
  let xmin = clampCoord(scaled[1]);
  let ymax = clampCoord(scaled[2]);
  let xmax = clampCoord(scaled[3]);

  if (ymin > ymax) {
    [ymin, ymax] = [ymax, ymin];
  }
  if (xmin > xmax) {
    [xmin, xmax] = [xmax, xmin];
  }

  // Reject zero-area degenerate bounding boxes
  if (ymax <= ymin || xmax <= xmin) {
    return null;
  }

  return [ymin, xmin, ymax, xmax];
}

function stripOuterCodeFence(text: string): string {
  const fenced = /^```(?:json|javascript|js)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```[ \t]*)?$/i.exec(
    text.trim(),
  );
  return fenced ? fenced[1].trim() : text.trim();
}

/**
 * Parses a Vision-LLM response into structured `0..1000` `[ymin, xmin, ymax, xmax]`
 * `VisionBoxRegion[]` items, gracefully falling back to `fallbackFullText` when a
 * model returns plain translated text or non-bbox JSON.
 */
export function parseVisionTranslationOutput(rawOutput: string): {
  regions: VisionBoxRegion[];
  fallbackFullText?: string;
} {
  const stripped = stripThinkingBlocks(rawOutput);
  if (!stripped) {
    return { regions: [] };
  }

  const unfenced = stripOuterCodeFence(stripped);

  // Locate candidate JSON payload (`[...]` or `{...}`)
  const candidates: string[] = [unfenced];
  const arrStart = unfenced.indexOf('[');
  const arrEnd = unfenced.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    candidates.push(unfenced.slice(arrStart, arrEnd + 1));
  }
  const objStart = unfenced.indexOf('{');
  const objEnd = unfenced.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    candidates.push(unfenced.slice(objStart, objEnd + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (Array.isArray(parsed) && parsed.length === 0) {
      return { regions: [] };
    }

    const rawList: unknown[] | null = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? Array.isArray((parsed as Record<string, unknown>).regions)
          ? ((parsed as Record<string, unknown>).regions as unknown[])
          : Array.isArray((parsed as Record<string, unknown>).items)
            ? ((parsed as Record<string, unknown>).items as unknown[])
            : (parsed as Record<string, unknown>).box !== undefined ||
                (parsed as Record<string, unknown>).bbox_2d !== undefined
              ? [parsed]
              : null
        : null;

    if (rawList) {
      const regions: VisionBoxRegion[] = [];
      const textOnlyFallbacks: string[] = [];

      for (const entry of rawList) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const trans = String(
          rec.trans ?? rec.translation ?? rec.target ?? rec.text ?? '',
        ).trim();
        const src = String(
          rec.src ?? rec.source ?? rec.original ?? '',
        ).trim();
        const box = normalizeBoxArray(
          rec.box ?? rec.bbox ?? rec.bbox_2d ?? rec.box_2d,
        );

        if (box && trans !== '') {
          regions.push({
            box,
            src,
            trans,
            ...(typeof rec.vertical === 'boolean'
              ? { vertical: rec.vertical }
              : {}),
          });
        } else if (trans !== '') {
          textOnlyFallbacks.push(trans);
        }
      }

      if (regions.length > 0) {
        return { regions };
      }
      if (textOnlyFallbacks.length > 0) {
        return {
          regions: [],
          fallbackFullText: textOnlyFallbacks.join('\n\n'),
        };
      }
    }

    // Object with `{ fullText / trans / translation }` without boxes
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const fallback =
        rec.fallbackFullText ?? rec.fullText ?? rec.trans ?? rec.translation ?? rec.text;
      if (typeof fallback === 'string' && fallback.trim() !== '') {
        return {
          regions: [],
          fallbackFullText: fallback.trim(),
        };
      }
    }
  }

  return {
    regions: [],
    fallbackFullText: unfenced,
  };
}
