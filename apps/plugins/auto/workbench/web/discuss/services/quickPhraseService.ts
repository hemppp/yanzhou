import type { Character } from '@novel/shared';

export async function generateQuickPhrases(
  content: string,
  characters: Character[],
): Promise<string[]> {
  if (!content || content.length < 100) {
    return [];
  }

  const contextChars = characters
    .slice(0, 10)
    .map((c) => `${c.name}${c.aliases?.length ? `（${c.aliases.join('、')}）` : ''}`)
    .join('、');

  const sampleText = content.length > 3000
    ? content.slice(0, 1500) + '\n...\n' + content.slice(-1500)
    : content;

  try {
    const { apiClient } = await import('@novel-plugins/data-core/api/apiClient');

    const result = await apiClient.post<{ suggestions: string[] }>(
      '/ai/gateway',
      {
        feature: 'quick-phrases',
        payload: {
          content: sampleText,
          characters: contextChars,
        },
      },
      { silent: true, timeoutMs: 30_000 }
    );

    if (result && result.suggestions && Array.isArray(result.suggestions)) {
      return result.suggestions
        .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 30)
        .slice(0, 8);
    }

    return [];
  } catch (e) {
    console.debug('[quickPhraseService] AI提取失败，使用启发式兜底:', e instanceof Error ? e.message : e);
    return extractHeuristicPhrases(content, characters);
  }
}

function extractHeuristicPhrases(content: string, characters: Character[]): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();

  for (const c of characters) {
    if (c.name && content.includes(c.name)) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        phrases.push(c.name);
      }
    }
    if (c.aliases) {
      for (const alias of c.aliases) {
        if (alias && content.includes(alias) && !seen.has(alias)) {
          seen.add(alias);
          phrases.push(alias);
        }
      }
    }
  }

  const patterns = [
    /「([^」]{1,15})」/g,
    /"([^"]{1,15})"/g,
    /['']([^'']{1,15})['']/g,
  ];
  const dialogueSet = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const text = match[1]?.trim();
      if (text && text.length >= 2 && text.length <= 15) {
        dialogueSet.add(text);
      }
    }
  }

  const dialogueCounts = new Map<string, number>();
  for (const d of dialogueSet) {
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(d, idx)) !== -1) {
      count++;
      idx += d.length;
    }
    if (count >= 2) {
      dialogueCounts.set(d, count);
    }
  }

  const topDialogues = Array.from(dialogueCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text]) => text);

  for (const d of topDialogues) {
    if (!seen.has(d)) {
      seen.add(d);
      phrases.push(d);
    }
  }

  return phrases.slice(0, 8);
}
