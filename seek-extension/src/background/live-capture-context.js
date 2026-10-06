export const FuguangLiveCaptureContext = (() => {
  const MAX_WINDOWS = 8;
  const MAX_SECONDS = 45;
  const MAX_CHARS = 1200;

  function recordSource(history, entry) {
    const next = (history || []).filter(item => item.chunkIndex !== entry.chunkIndex);
    next.push({ ...entry, translation: "" });
    return next.sort((a, b) => a.chunkIndex - b.chunkIndex).slice(-MAX_WINDOWS);
  }

  function recordTranslation(history, chunkIndex, translation) {
    return (history || []).map(item => item.chunkIndex === chunkIndex
      ? { ...item, translation: String(translation || "").trim() }
      : item);
  }

  function precedingContext(history, chunkIndex, videoStart) {
    const preceding = (history || []).filter(item =>
      item.chunkIndex < chunkIndex && item.videoEnd >= videoStart - MAX_SECONDS
    ).slice(-MAX_WINDOWS);
    return {
      previousSource: preceding.map(item => item.source).filter(Boolean).join("\n").slice(-MAX_CHARS),
      previousTranslation: preceding.map(item => item.translation).filter(Boolean).join("\n").slice(-MAX_CHARS)
    };
  }

  function deduplicateOverlap(history, chunkIndex, videoStart, overlapSeconds, segments) {
    if (!overlapSeconds || !Array.isArray(segments) || segments.length !== 1) return segments;
    const previous = (history || []).filter(item => item.chunkIndex < chunkIndex).at(-1);
    const current = segments[0];
    if (!previous || previous.videoEnd < videoStart - 0.15 ||
        previous.videoEnd > videoStart + overlapSeconds + 0.4 ||
        Number(current.start) > previous.videoEnd + 0.15) return segments;

    const comparable = text => {
      const characters = [];
      const ends = [];
      let offset = 0;
      for (const character of String(text || "")) {
        offset += character.length;
        if (/[\s\p{P}\p{S}]/u.test(character)) continue;
        characters.push(character.toLowerCase());
        ends.push(offset);
      }
      return { characters, ends };
    };
    const oldText = comparable(previous.source);
    const newText = comparable(current.text);
    const maximum = Math.min(oldText.characters.length, newText.characters.length, 80);
    for (let count = maximum; count >= 3; count -= 1) {
      if (oldText.characters.slice(-count).join("") !== newText.characters.slice(0, count).join("")) continue;
      const remainder = String(current.text).slice(newText.ends[count - 1])
        .replace(/^[\s\p{P}\p{S}]+/u, "").trim();
      if (!remainder) return [];
      return [{
        ...current,
        start: Math.min(Number(current.end) - 0.05, Math.max(Number(current.start), previous.videoEnd)),
        text: remainder
      }];
    }
    return segments;
  }

  return { recordSource, recordTranslation, precedingContext, deduplicateOverlap };
})();
