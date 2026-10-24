import type { IndexItem } from "../types.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "is",
  "are",
  "be",
  "with",
  "my",
  "me",
  "i",
  "it",
  "this",
  "that",
  "please",
  "can",
  "you",
  "how",
  "do",
  "does",
  "want",
  "need",
]);

const TOKEN_RE = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE) || [];
  return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function bm25Text(item: IndexItem): string {
  return [
    item.name.replace(/-/g, " "),
    item.description,
    item.when_to_use,
    (item.categories || []).join(" "),
    (item.aliases || []).join(" "),
  ].join(" ");
}

export interface BM25Hit {
  index: number;
  score: number;
}

export class BM25Index {
  private readonly documents: string[][];
  private readonly documentFrequency = new Map<string, number>();
  private readonly idf = new Map<string, number>();
  private readonly averageLength: number;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(texts: string[]) {
    this.documents = texts.map(tokenize);
    const totalLength = this.documents.reduce(
      (sum, document) => sum + document.length,
      0,
    );
    this.averageLength = this.documents.length
      ? totalLength / this.documents.length
      : 0;

    for (const document of this.documents) {
      for (const token of new Set(document)) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) || 0) + 1,
        );
      }
    }
    for (const [token, frequency] of this.documentFrequency) {
      this.idf.set(
        token,
        Math.log(
          1 +
            (this.documents.length - frequency + 0.5) / (frequency + 0.5),
        ),
      );
    }
  }

  search(query: string, limit: number): BM25Hit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0 || this.documents.length === 0) return [];
    const scores = this.documents.map((document) => {
      if (document.length === 0) return 0;
      const frequencies = new Map<string, number>();
      for (const token of document) {
        frequencies.set(token, (frequencies.get(token) || 0) + 1);
      }
      let score = 0;
      for (const token of tokens) {
        const frequency = frequencies.get(token) || 0;
        if (frequency === 0) continue;
        const idf = this.idf.get(token) || 0;
        const denominator =
          frequency +
          this.k1 *
            (1 - this.b + (this.b * document.length) / (this.averageLength || 1));
        score += (idf * (frequency * (this.k1 + 1))) / denominator;
      }
      return score;
    });

    return scores
      .map((score, index) => ({ index, score }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
